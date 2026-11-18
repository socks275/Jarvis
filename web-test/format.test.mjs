import assert from 'node:assert/strict';
import { test } from 'node:test';
import MarkdownIt from 'markdown-it';
import { createFormatter } from '../web/format.mjs';

const format = createFormatter(MarkdownIt);

test('models can produce rich Markdown but cannot add HTML, external images, or unsafe links', () => {
  const formatted = format('# Heading\n\n**Bold**\n\n- One\n- Two\n\n```js\nconst answer = 42;\n```\n\n[Link](https://example.com/)');
  assert.match(formatted, /<h1>Heading<\/h1>/);
  assert.match(formatted, /<strong>Bold<\/strong>/);
  assert.match(formatted, /<li>One<\/li>/);
  assert.match(formatted, /<pre><code class="language-js">const answer = 42;/);
  assert.match(formatted, /href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer"/);
  const escaped = format('![picture](https://example.com/private)\n\n<a onclick="notAllowed()">raw</a>\n\n[click](javascript:alert%281%29)\n\n[other](/app.mjs)');
  assert.doesNotMatch(escaped, /<img|<a\b|href=/);
  assert.match(escaped, /&lt;a onclick=/);
  assert.match(escaped, /picture/);
});
