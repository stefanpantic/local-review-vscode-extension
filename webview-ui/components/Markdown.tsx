import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// GitHub bodies routinely embed raw HTML (notably <details>/<summary> in bot PRs like Dependabot).
// rehype-raw parses that HTML; rehype-sanitize then strips anything unsafe, so no script or event handler
// can run in the webview. Keep the disclosure tags that make long bot descriptions collapsible.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
};

/** Shared GitHub-flavored markdown renderer for comment and pull-request bodies (safe raw-HTML support). */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}>
      {children}
    </ReactMarkdown>
  );
}
