// Ported from mp/layout/draw.kt (JinpuPainter). Renders the page tree to SVG
// (replacing Skija Canvas drawing) and provides resize/title-page/pick.

import { Point, Rect, colorToCss } from "../common/geom";
import { Font } from "./font";
import {
  GraphicLine,
  GraphicPath,
  Group,
  Layout,
  NoteEntry,
  PageItem,
  TextFrame,
  SmuflText,
} from "./layout";
import { Chord, Score } from "../score/score";

const SVG_NS = "http://www.w3.org/2000/svg";

export class JinpuPainter {
  layout: Layout;
  score = new Score();
  pageWidth = 0;
  pageHeight = 0;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** Chord -> its note-entry groups (one per rendered verse/pass), for playback cursor. */
  private chordItem = new Map<Chord, { page: number; item: PageItem; verse: number }[]>();
  private highlighted: PageItem | null = null;

  constructor(fontSize: number) {
    this.layout = new Layout(fontSize);
  }

  resize(w: number, h: number, dur: string | null): void {
    this.pageWidth = w;
    this.pageHeight = h;
    this.layout.fromScore(this.score, dur, w, h);
    this.layout.pages.unshift(this.titlePage(w, h));
    for (const p of this.layout.pages) p.update();
    this.buildChordIndex();
  }

  /** Walk each page tree, mapping every Chord to its note-entry group(s). */
  private buildChordIndex(): void {
    this.chordItem.clear();
    this.highlighted = null;
    const walk = (item: PageItem, page: number): void => {
      if (item.data instanceof NoteEntry) {
        const ch = item.data.chord;
        if (ch) {
          const list = this.chordItem.get(ch) ?? [];
          list.push({ page, item, verse: item.data.verse });
          this.chordItem.set(ch, list);
        }
      }
      for (const c of item.children) walk(c, page);
    };
    this.layout.pages.forEach((pg, i) => walk(pg, i));
  }

  /** The rendered entry for a chord at a given pass/verse (falls back to first). */
  private hitFor(chord: Chord, pass: number): { page: number; item: PageItem } | null {
    const list = this.chordItem.get(chord);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.verse === pass) ?? list[0];
  }

  /** Highlight the note of `chord` at `pass` (clearing any previous). Returns page index. */
  highlightChord(chord: Chord | null, pass = 0): number | null {
    if (this.highlighted) {
      this.nodeMap.get(this.highlighted)?.classList.remove("playing");
      this.highlighted = null;
    }
    if (!chord) return null;
    const hit = this.hitFor(chord, pass);
    if (!hit) return null;
    this.nodeMap.get(hit.item)?.classList.add("playing");
    this.highlighted = hit.item;
    return hit.page;
  }

  /** SVG <g> for a chord's note at `pass` (for scroll-into-view); null if not rendered. */
  chordGroupEl(chord: Chord, pass = 0): SVGGElement | null {
    const hit = this.hitFor(chord, pass);
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  private multipleLineText(str: string, fnt: Font, w: number, clr: number): PageItem {
    const arr = str.split("\n");
    const grp = new Group();
    let ypos = 0;
    const fm = fnt.metrics;
    const height = fm.descent - fm.ascent;
    for (const it of arr) {
      const tf = new TextFrame();
      tf.color = clr;
      tf.font = fnt;
      tf.text = it;
      const ww = tf.measureText();
      tf.x = (w - ww) / 2;
      tf.y = ypos;
      ypos += height;
      if (arr.length === 1) return tf;
      grp.add(tf);
    }
    return grp;
  }

  titlePage(w: number, h: number): Group {
    const opt = this.layout.options;
    const fnt = opt.lrcFont;
    const pg = new Group();
    let titleCount = 0;
    const texts: string[] = [];
    const fonts: Font[] = [];
    for (const it of this.score.credit) {
      const isTitle = it.type === "title";
      const sz = isTitle ? opt.titleSize : opt.creditSize;
      if (isTitle) {
        titleCount++;
        texts.unshift(it.text);
        fonts.unshift(fnt.makeWithSize(sz));
      } else {
        texts.push(it.text);
        fonts.push(fnt.makeWithSize(sz));
      }
    }
    if (titleCount === 0) {
      if (this.score.title.trim().length > 0) {
        titleCount = 1;
        texts.unshift(this.score.title);
        fonts.unshift(fnt.makeWithSize(opt.titleSize));
      }
    }
    if (titleCount !== 1) console.error("title count error!");
    let ypos = 0.3 * h;
    texts.forEach((text, idx) => {
      const font = fonts[idx];
      const obj = this.multipleLineText(text, font, w, opt.color);
      obj.y = ypos;
      obj.update();
      pg.add(obj);
      ypos += obj.height;
    });
    return pg;
  }

  // ---------------- SVG rendering ----------------

  /** Render one page group into a standalone <svg> of pageWidth x pageHeight. */
  renderPage(pageIndex: number): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "score-page");
    svg.setAttribute("viewBox", `0 0 ${this.pageWidth} ${this.pageHeight}`);
    const pg = this.layout.pages[pageIndex];
    svg.appendChild(renderPageItem(pg, this.nodeMap));
    return svg;
  }

  /**
   * "整页 A4"渲染：把整首简谱排进 A4（默认 595×842，与选项面板 A4 一致）。
   * 短谱→单张 A4，标题+词曲作者叠加在**同一页顶部**、简谱紧随其下（不分页）；
   * 超长谱→自动分页，首页顶部同样叠主标题。用**独立临时 Layout** 排版，
   * 不触碰 this.layout / this.layout.pages，故不影响多页预览、点选、播放高亮。
   */
  renderA4Svgs(width = 595, height = 842): SVGSVGElement[] {
    const o = this.layout.options;
    const tmp = new Layout(this.layout.fontSize);
    const to = tmp.options;
    to.color = o.color;
    to.smuflMeta = o.smuflMeta;
    to.titleSize = o.titleSize;
    to.creditSize = o.creditSize;
    to.smuflAsPath = o.smuflAsPath;
    to.halfWidthPunct = o.halfWidthPunct;
    to.ignoreVerseNumber = o.ignoreVerseNumber;
    to.slurTieThickness = o.slurTieThickness;
    to.staffDist = o.staffDist;
    to.marginTop = o.marginTop;
    to.marginBottom = o.marginBottom;
    to.marginLeft = o.marginLeft;
    to.maxLineDist = o.maxLineDist;
    to.maxHorizontalScale = o.maxHorizontalScale;
    to.jpBeamDist = o.jpBeamDist;
    to.lrcFont = o.lrcFont;
    to.numberFont = o.numberFont;
    to.smuflFont = o.smuflFont;

    tmp.fromScore(this.score, null, width, height);

    const titleLines = this.a4TitleLines();
    const titleH = this.a4TitleHeight(titleLines);
    const svgs: SVGSVGElement[] = [];
    tmp.pages.forEach((pg, idx) => {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "score-page a4-page");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      const g = renderPageItem(pg, undefined);
      if (idx === 0) g.setAttribute("transform", `translate(0 ${titleH})`);
      svg.appendChild(g);
      if (idx === 0) this.appendTitleBlock(svg, titleLines, width);
      svgs.push(svg);
    });
    return svgs;
  }

  /** A4 顶部标题块：标题（titleSize）+ 词曲作者（creditSize），居中，支持多行。 */
  private a4TitleLines(): { text: string; size: number }[] {
    const o = this.layout.options;
    const texts: { text: string; size: number }[] = [];
    let titleCount = 0;
    for (const it of this.score.credit) {
      const isTitle = it.type === "title";
      const size = isTitle ? o.titleSize : o.creditSize;
      const item = { text: it.text, size };
      if (isTitle) { titleCount++; texts.unshift(item); }
      else texts.push(item);
    }
    if (titleCount === 0 && this.score.title.trim().length > 0) {
      texts.unshift({ text: this.score.title, size: o.titleSize });
    }
    return texts;
  }

  private a4TitleHeight(lines: { text: string; size: number }[]): number {
    let y = 24;
    for (const ln of lines) {
      for (const seg of ln.text.split("\n")) {
        if (seg.trim() === "") continue;
        y += ln.size * 1.3;
      }
      y += ln.size * 0.4;
    }
    return Math.max(y, 40);
  }

  private appendTitleBlock(
    svg: SVGSVGElement,
    lines: { text: string; size: number }[],
    width: number,
  ): void {
    const o = this.layout.options;
    let y = 24;
    for (const ln of lines) {
      for (const seg of ln.text.split("\n")) {
        if (seg.trim() === "") continue;
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("x", String(width / 2));
        t.setAttribute("y", String(y + ln.size * 0.8));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-family", o.lrcFont.family);
        t.setAttribute("font-size", String(ln.size));
        t.setAttribute("fill", colorToCss(o.color));
        t.textContent = seg;
        svg.appendChild(t);
        y += ln.size * 1.3;
      }
      y += ln.size * 0.4;
    }
  }


  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  // ---------------- picking (Phase 3) ----------------

  private calcDist(x: number, y: number, inn: Rect): number {
    let dx = 0;
    if (x < inn.left) dx = inn.left - x;
    else if (x > inn.right) dx = x - inn.right;
    let dy = 0;
    if (y < inn.top) dy = inn.top - y;
    else if (y > inn.bottom) dy = y - inn.bottom;
    return dx + dy;
  }

  pick(root: PageItem, x: number, y: number): [PageItem | null, number] {
    let bnd = root.bound;
    bnd = bnd.offset(root.x, root.y);
    const edge = 5;
    const dist = this.calcDist(x, y, bnd);
    if (root.children.length === 0) {
      let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
      const dx = Math.min(bnd.width - edge * 2, 0) / 2;
      const dy = Math.min(bnd.height - edge * 2, 0) / 2;
      outer = outer.inset(dx, dy);
      return outer.contains(x, y) ? [root, dist] : [null, dist];
    }
    let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
    outer = outer.inset(-edge, -edge);
    if (outer.contains(x, y)) {
      const xx = x - bnd.left;
      const yy = y - bnd.top;
      const items: PageItem[] = [];
      let minDist = Number.MAX_VALUE;
      let best: PageItem | null = null;
      let small: PageItem | null = null;
      for (const ch of root.children) {
        const [p, pd] = this.pick(ch, xx, yy);
        if (p !== null) {
          if (pd < minDist) {
            best = p;
            minDist = pd;
            items.length = 0;
            items.push(p);
          }
          if (pd === minDist) items.push(p);
          if (ch.bound.width < edge || ch.bound.height < edge) small = ch;
        }
      }
      if (small !== null) return [small, 0];
      let area = Number.MAX_VALUE;
      for (const it of items) {
        const a = it.bound.width * it.bound.height;
        if (a < area) {
          best = it;
          area = a;
        }
      }
      return [best, minDist];
    }
    return [null, Number.MAX_VALUE];
  }

  pickPage(page: number, pos: Point): PageItem | null {
    const pg = this.layout.pages[page];
    const [p] = this.pick(pg, pos.x, pos.y);
    return p;
  }
}

// Recursively build an SVG <g> for a PageItem (matrix transform + self shape +
// children), mirroring draw.kt's drawPageItem (save/concat/drawTo/recurse).
export function renderPageItem(
  item: PageItem,
  nodeMap?: WeakMap<PageItem, SVGGElement>,
): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
  const self = renderSelf(item);
  if (self) g.appendChild(self);
  for (const ch of item.children) g.appendChild(renderPageItem(ch, nodeMap));
  nodeMap?.set(item, g);
  return g;
}

function renderSelf(item: PageItem): SVGElement | null {
  if (item instanceof GraphicPath) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", item.d);
    if (item.fill) p.setAttribute("fill", colorToCss(item.fillColor));
    else p.setAttribute("fill", "none");
    if (item.stroke) {
      p.setAttribute("stroke", colorToCss(item.strokeColor));
      p.setAttribute("stroke-width", String(item.strokeWidth));
    }
    return p;
  }
  if (item instanceof GraphicLine) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", String(item.p0.x));
    l.setAttribute("y1", String(item.p0.y));
    l.setAttribute("x2", String(item.p1.x));
    l.setAttribute("y2", String(item.p1.y));
    l.setAttribute("stroke", colorToCss(item.strokeColor));
    l.setAttribute("stroke-width", String(item.strokeWidth));
    l.setAttribute("stroke-linecap", "butt");
    return l;
  }
  if (item instanceof TextFrame) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", "0");
    t.setAttribute("y", "0");
    const family = item instanceof SmuflText ? "Bravura" : item.font.family;
    t.setAttribute("font-family", family);
    t.setAttribute("font-size", String(item.font.size));
    if (item.font.bold) t.setAttribute("font-weight", "bold");
    t.setAttribute("fill", colorToCss(item.color));
    t.textContent = item.text;
    return t;
  }
  return null; // Group / bare PageItem: children only
}
