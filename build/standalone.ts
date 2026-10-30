import type { OutputBundle } from 'rollup';
import type { Plugin } from 'vite';

const sourceText = (source: string | Uint8Array) => typeof source === 'string' ? source : new TextDecoder().decode(source);
const reference = (path: string) => path.replace(/^\.?\//, '');

/** Embed Vite's generated files; reject splits instead of shipping a broken file:// app. */
export function embedBundle(bundle: OutputBundle): { html: string; embedded: string[] } {
  const index = bundle['index.html'];
  if (!index || index.type !== 'asset') throw new Error('Standalone build requires index.html.');
  const embedded = new Set<string>();
  let scripts = 0;
  // Replace original HTML tags in one pass; embedded JS/CSS may contain tag strings.
  const html = sourceText(index.source).replace(/<script\b[^>]*\bsrc=(["']).*?\1[^>]*>\s*<\/script\s*>|<link\b[^>]*>/gi, tag => {
    if (/^<script\b/i.test(tag)) {
      const path = /\bsrc=(["'])(.*?)\1/i.exec(tag)![2];
      const name = reference(path), chunk = bundle[name];
      if (!chunk || chunk.type !== 'chunk' || !chunk.isEntry || chunk.imports.length || chunk.dynamicImports.length) {
        throw new Error(`Cannot embed script "${path}". The standalone app must have one entry and no external imports.`);
      }
      scripts++;
      embedded.add(name);
      // HTML's raw-text parser recognizes these sequences even inside JS strings.
      const code = chunk.code.replace(/<\/script/gi, match => match.replace('/', '\\/'))
        .replace(/<!--|<script/gi, match => `\\x3c${match.slice(1)}`);
      return `<script type="module">${code}</script>`;
    }
    if (!/\brel=(["'])stylesheet\1/i.test(tag)) return tag;
    const path = /\bhref=(["'])(.*?)\1/i.exec(tag)?.[2];
    const name = path && reference(path), asset = name && bundle[name];
    if (!name || !asset || asset.type !== 'asset' || !name.endsWith('.css')) throw new Error(`Cannot embed stylesheet "${path}".`);
    embedded.add(name);
    const css = sourceText(asset.source).replace(/<\/style/gi, match => match.replace('/', '\\/'));
    return `<style>${css}</style>`;
  });
  if (scripts !== 1) throw new Error('Standalone build requires exactly one app script.');
  const remaining = Object.keys(bundle).filter(name => name !== 'index.html' && !embedded.has(name));
  if (remaining.length) throw new Error(`Standalone build has unembedded files: ${remaining.join(', ')}.`);
  return { html, embedded: [...embedded] };
}

export function standalone(): Plugin {
  return {
    name: 'standalone-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const { html, embedded } = embedBundle(bundle);
      const index = bundle['index.html'];
      if (index.type === 'asset') index.source = html;
      for (const name of embedded) delete bundle[name];
    },
  };
}
