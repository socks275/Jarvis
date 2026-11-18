// Render only Markdown; model-supplied HTML and remote images are never interpreted.
export function createFormatter(MarkdownIt) {
  const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
  markdown.validateLink = (url) => /^https?:\/\//i.test(url);
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
  markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  return (text) => markdown.render(text);
}
