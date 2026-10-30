import { describe, expect, it } from 'vitest';
import type { OutputBundle, OutputChunk } from 'rollup';
import { embedBundle } from './standalone';

function fixture(code = 'document.body.textContent = "ready";'): OutputBundle {
  return {
    'index.html': { type: 'asset', fileName: 'index.html', names: [], originalFileNames: [], needsCodeReference: false,
      source: '<html><head><script type="module" crossorigin src="./assets/app.js"></script><link rel="stylesheet" crossorigin href="./assets/app.css"></head><body></body></html>' },
    'assets/app.js': { type: 'chunk', fileName: 'assets/app.js', isEntry: true, imports: [], dynamicImports: [], code } as unknown as OutputChunk,
    'assets/app.css': { type: 'asset', fileName: 'assets/app.css', names: [], originalFileNames: [], needsCodeReference: false, source: 'body{color:red}' },
  };
}

describe('standalone download', () => {
  it('embeds JavaScript and CSS without fetching generated files', () => {
    const { html, embedded } = embedBundle(fixture());
    expect(html).toContain('<script type="module">document.body.textContent = "ready";</script>');
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).not.toMatch(/\b(?:src|href)=/);
    expect(embedded).toEqual(['assets/app.js', 'assets/app.css']);
  });

  it('preserves JS strings without letting them terminate or escape the HTML script', () => {
    const text = '</SCRIPT><script><!--<link rel="stylesheet" href="example.css">';
    const { html } = embedBundle(fixture(`globalThis.example = ${JSON.stringify(text)};`));
    const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
    const scope: { example?: string } = {};
    new Function('globalThis', code)(scope);
    expect(scope.example).toBe(text);
    expect(code).not.toMatch(/<\/script|<script|<!--/i);
  });

  it('rejects imports and leftover chunks that would break direct file opening', () => {
    const imported = fixture();
    (imported['assets/app.js'] as OutputChunk).imports = ['dependency.js'];
    expect(() => embedBundle(imported)).toThrow('no external imports');
    const split = fixture();
    split['extra.js'] = { ...(split['assets/app.js'] as OutputChunk), fileName: 'extra.js', isEntry: false };
    expect(() => embedBundle(split)).toThrow('unembedded files: extra.js');
  });
});
