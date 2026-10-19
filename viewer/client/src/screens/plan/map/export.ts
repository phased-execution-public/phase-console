/**
 * Export the map as it is drawn (one-pool phase 16, #376): an SVG file, or a
 * PNG of the same picture.
 *
 * The SVG on the page is painted by a stylesheet (`route-map.css`) and by the
 * theme's variables, neither of which travels with the file. So the export is
 * a CLONE of the drawing whose every element carries the computed values of
 * the properties a picture needs, written inline — the file then looks as the
 * frame did, opened anywhere. The view box is the frame's own: the export is
 * the CURRENT view (its zoom, its filters, its layers), not the whole plan.
 *
 * The PNG is that SVG drawn onto a canvas through a `data:` image — the
 * console's CSP allows `img-src data:` and nothing wider, so a `blob:` image
 * would be refused — at twice the frame's size, on the page's own ground.
 */

/** The properties a drawing's look depends on — everything else is the browser's default. */
export const PAINT_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'paint-order',
  'visibility',
  'display',
] as const;

/** Values that say nothing a default would not — kept out so the file stays readable. */
const SILENT = new Set(['', 'normal', 'auto', 'visible', 'inline', 'none 0s ease 0s 1 normal none running']);

/** A filename-safe stem for the file: the plan and the view. */
export function exportName(slug: string, ext: 'svg' | 'png'): string {
  const stem = slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plan';
  return `${stem}-map.${ext}`;
}

/**
 * The drawing as a standalone SVG document: cloned, each element's computed
 * paint written inline, the view box kept, the width and height the frame's
 * own pixels. `read` is `getComputedStyle` — injectable for a test.
 */
export function svgMarkup(
  svg: SVGSVGElement,
  read: (el: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'> = (el) => getComputedStyle(el),
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg, ...svg.querySelectorAll('*')];
  const target = [clone, ...clone.querySelectorAll('*')];
  source.forEach((el, i) => {
    const out = target[i] as SVGElement | undefined;
    if (!out) return;
    const style = read(el);
    const inline: string[] = [];
    for (const prop of PAINT_PROPERTIES) {
      const value = style.getPropertyValue(prop).trim();
      if (!SILENT.has(value)) inline.push(`${prop}:${value}`);
    }
    // An animation's starting frame (the track draws itself in) must not be
    // what the file keeps: the dash offset is the drawing's settled one.
    inline.push('animation:none', 'transition:none');
    out.setAttribute('style', inline.join(';'));
    out.removeAttribute('tabindex');
  });
  // A hit area is an input, not a picture.
  for (const hit of clone.querySelectorAll('.route-station-hit')) hit.remove();
  const box = svg.getBoundingClientRect();
  if (box.width > 0) clone.setAttribute('width', String(Math.round(box.width)));
  if (box.height > 0) clone.setAttribute('height', String(Math.round(box.height)));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.removeAttribute('role');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Hand the browser a file to save. */
function save(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

export function downloadSvg(svg: SVGSVGElement, slug: string): string {
  const markup = svgMarkup(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  save(url, exportName(slug, 'svg'));
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return markup;
}

/** The SVG as a `data:` URL — the one image source the console's CSP admits. */
export const svgDataUrl = (markup: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

/**
 * The PNG: the SVG drawn at `scale` on a canvas painted with the page's
 * ground first, so a dark theme's map is not exported onto transparency.
 * Resolves to the data URL it saved, or `null` when the browser could not draw.
 */
export async function downloadPng(svg: SVGSVGElement, slug: string, scale = 2): Promise<string | null> {
  const markup = svgMarkup(svg);
  const box = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round((box.width || 1000) * scale));
  const h = Math.max(1, Math.round((box.height || 600) * scale));
  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = svgDataUrl(markup);
  if (!(await loaded)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const frame = svg.closest('.route-frame');
  ctx.fillStyle = getComputedStyle(frame ?? document.body).backgroundColor || 'transparent';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const url = canvas.toDataURL('image/png');
  save(url, exportName(slug, 'png'));
  return url;
}
