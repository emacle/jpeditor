// 简谱一键转调 —— 把 app.py（JP-Word .jpwabc 一键转调 Web 应用）的核心算法
// 逐字移植为 TypeScript，作用于 .jpwabc **文本层**：
//   1. .Voice 节：识别 `[#b♯♭]?[1-7]` 音符 + `'`/`,` 八度记号，保持绝对音高不变，
//      按目标调重映射并在跨越十二度边界时自动升/降八度；其余符号原样保留。
//   2. .Title 节：把 KeyAndMeters = {1=原调,4/4} 改写为 1=目标调。
//   其余节（.Words/.Repeat/.Layout 等）原样保留。
//
// 转调后文本直接交给现有 setText() 触发重排，天然集成进 编辑/预览/导出 流程。

// 从 C 开始计数的半音唱名表，索引即半音数
export const C_CHROMATIC = [
  "1", "#1", "2", "#2", "3", "4",
  "#4", "5", "#5", "6", "#6", "7",
];

// 降号记法 -> 唱名（把 "b" 降号记法归一化到升号记法，便于查表）
const FLAT_TO_SHARP: Record<string, string> = {
  b7: "#6", b6: "#5", b5: "#4", b4: "3",
  b3: "#2", b2: "#1", b1: "7",
};

// 调号字母对应的基础半音数（相对 C）
const LETTER_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** 把调号字符串（如 "C"、"bE"、"#C"、"Bb"、"F#"）解析成相对 C 的半音偏移（0-11）。 */
export function keyToOffset(keyStr: string): number {
  let s = keyStr.trim().replace(/ /g, "");
  if (!s) throw new Error("空调号");
  // 处理升降号（支持 ASCII 与 Unicode 记法）
  let acc = 0;
  while (s && /[#b♯♭]/.test(s[0])) {
    if (s[0] === "#" || s[0] === "♯") acc += 1;
    else acc -= 1;
    s = s.slice(1);
  }
  if (!s) throw new Error("无音名：" + keyStr);
  const letter = s[0].toUpperCase();
  if (!(letter in LETTER_SEMITONE)) throw new Error("无法识别的调号：" + keyStr);
  return (((LETTER_SEMITONE[letter] + acc) % 12) + 12) % 12;
}

/** 把音符记号（"1"~"7" 或带升降号）转成相对 C 的半音序号 0~11。降号先归一化为升号。 */
function degreeIndex(note: string): number {
  let n = note;
  if (n in FLAT_TO_SHARP) n = FLAT_TO_SHARP[n];
  const idx = C_CHROMATIC.indexOf(n);
  if (idx < 0) throw new Error("bad degree: " + note);
  return idx;
}

/** 该音符对应的绝对半音数（相对 C），octaveShift 由 , / ' 决定。 */
function absSemitone(keyOffset: number, degreeIndex: number, octaveShift: number): number {
  return keyOffset + degreeIndex + 12 * octaveShift;
}

/** 把绝对半音数按目标调（相对 C 的偏移 targetOffset）转换，并用本文件记法（' 高、, 低）标注八度。 */
function formatResult(absP: number, targetOffset = 0): string {
  const rel = absP - targetOffset;
  const newDi = ((rel % 12) + 12) % 12;
  const octave = Math.floor(rel / 12); // Python 的 //（向下取整），兼容负 rel
  const name = C_CHROMATIC[newDi];
  if (octave > 0) return name + "'".repeat(octave);
  if (octave < 0) return name + ",".repeat(-octave);
  return name;
}

/**
 * 转换 .Voice 节（保持绝对音高不变的"八度正确"转换）：
 * 对每个音符，先按原谱记法算出真实音高（数字 + 升降号 + 高低八度 + 调号偏移），
 * 再换算成"目标调"并重新标注正确的八度——当转换跨越十二度边界时自动升高/降低八度。
 * 休止符 0 与其它记号（括号、小节线、反复记号、连行符、减时线等）原样保留。
 */
export function convertVoice(voiceText: string, keyOffset: number, targetOffset = 0): string {
  const out: string[] = [];
  let i = 0;
  const n = voiceText.length;
  while (i < n) {
    const ch = voiceText[i];
    if (/[#b♯♭]/.test(ch) && i + 1 < n && /[1234567]/.test(voiceText[i + 1])) {
      const noteChar = /[b♭]/.test(ch) ? "b" : "#";
      const digit = voiceText[i + 1];
      i += 2;
      // 读取音符后面的八度记号（' 高音、, 低音）
      let octaveShift = 0;
      while (i < n && (voiceText[i] === "'" || voiceText[i] === ",")) {
        octaveShift += voiceText[i] === "'" ? 1 : -1;
        i += 1;
      }
      const di = degreeIndex(noteChar + digit);
      out.push(formatResult(absSemitone(keyOffset, di, octaveShift), targetOffset));
    } else if (/[0-7]/.test(ch)) {
      const digit = ch;
      i += 1;
      if (digit === "0") {
        out.push("0"); // 休止符
        continue;
      }
      let octaveShift = 0;
      while (i < n && (voiceText[i] === "'" || voiceText[i] === ",")) {
        octaveShift += voiceText[i] === "'" ? 1 : -1;
        i += 1;
      }
      const di = degreeIndex(digit);
      out.push(formatResult(absSemitone(keyOffset, di, octaveShift), targetOffset));
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

/** 把 .Title 节中 KeyAndMeters 行的调号标记 1=xxx 替换为目标调名。 */
export function convertKeyAndMeters(titleText: string, targetKeyName = "C"): string {
  return titleText.replace(
    /(KeyAndMeters\s*=\s*\{[^,}]*1\s*=\s*)[#b♯♭]?([A-Ga-g])(\s*[,}])/,
    (_m, p1, _p2, p3) => p1 + targetKeyName + p3,
  );
}

/** 按 ".***" 开头的节标题切分。返回 [(节名, 内容), ...]，每个元素含该节标题行。语义与 app.py find_sections 一致。 */
export function findSections(text: string): Array<[string, string]> {
  const lines = text.split(/(?<=\n)/); // keepends
  const sections: Array<[string, string]> = [];
  let current: string | null = null;
  const buf: string[] = [];
  for (const line of lines) {
    const m = /^\.(\w+)/.exec(line);
    if (m) {
      if (current !== null) sections.push([current, buf.join("")]);
      current = m[1];
      buf.length = 0;
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  if (current !== null) sections.push([current, buf.join("")]);
  return sections;
}

/** 从 .Title 节中读取 KeyAndMeters = {1=bE,4/4} 里的调号，返回如 "bE"；找不到返回 null。 */
export function extractKey(titleText: string): string | null {
  let m = /KeyAndMeters\s*=\s*\{[^,}]*1\s*=\s*([#b♯♭]?[A-Ga-g])\s*[,}]/.exec(titleText);
  if (!m) {
    // 兼容只有 {1=bE} 或 {1=C} 的情况
    m = /\b1\s*=\s*([#b♯♭]?[A-Ga-g])\b/.exec(titleText);
  }
  return m ? m[1] : null;
}

/** 返回 (原调唱名列表, 新调唱名列表)，用于前端对齐表格展示。 */
export function mappingTable(keyOffset: number, targetOffset = 0): { keys: string[]; vals: string[] } {
  const keys: string[] = [];
  const vals: string[] = [];
  for (const src of C_CHROMATIC) {
    const di = C_CHROMATIC.indexOf(src);
    keys.push(src);
    vals.push(formatResult(keyOffset + di, targetOffset));
  }
  return { keys, vals };
}

export interface TransposeInfo {
  ok: boolean;
  error?: string;
  sourceKey?: string;
  targetKey?: string;
  mappingKeys?: string[];
  mappingVals?: string[];
  converted?: string;
}

/**
 * 完整转换一个 .jpwabc 文件内容为指定的"目标调"（默认 C 调）。
 * 返回 {文本, 信息字典}（与 app.py convert_jpwabc 对齐，name 用驼峰）。
 */
export function transposeJpwabc(text: string, targetKeyName = "C"): { text: string; info: TransposeInfo } {
  const sections = findSections(text);

  // 读取调号
  let sourceKeyName: string | null = null;
  for (const [name, content] of sections) {
    if (name === "Title") {
      sourceKeyName = extractKey(content);
      break;
    }
  }

  if (!sourceKeyName) {
    return {
      text,
      info: {
        ok: false,
        error: "未能在 .Title 节中找到调号（KeyAndMeters 形如 1=bE），无法转换。",
      },
    };
  }

  let keyOffset: number;
  let targetOffset: number;
  try {
    keyOffset = keyToOffset(sourceKeyName);
    targetOffset = keyToOffset(targetKeyName);
  } catch (e) {
    return { text, info: { ok: false, error: e instanceof Error ? e.message : String(e) } };
  }

  // 逐节处理：.Voice 转换；.Title 的调号改为目标调
  const newSections: Array<[string, string]> = [];
  for (const [name, content] of sections) {
    if (name === "Voice") {
      newSections.push([name, convertVoice(content, keyOffset, targetOffset)]);
    } else if (name === "Title") {
      newSections.push([name, convertKeyAndMeters(content, targetKeyName)]);
    } else {
      newSections.push([name, content]);
    }
  }

  // 重组文件
  const newText = newSections.map(([, content]) => content).join("");

  const mt = mappingTable(keyOffset, targetOffset);
  return {
    text: newText,
    info: {
      ok: true,
      sourceKey: sourceKeyName,
      targetKey: targetKeyName,
      mappingKeys: mt.keys,
      mappingVals: mt.vals,
      converted: newText,
    },
  };
}
