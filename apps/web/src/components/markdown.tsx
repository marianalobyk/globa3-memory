import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Renders brief and report Markdown.
 *
 * External links open in a new tab with rel="noreferrer": a brief's sources are
 * third-party URLs found during research, and nothing in them should be able to
 * reach back into the app.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-brief max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren, ...props }) => (
            <a
              href={href}
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noreferrer noopener' : undefined}
              {...props}
            >
              {linkChildren}
            </a>
          ),
          table: ({ children: tableChildren, ...props }) => (
            <div className="scroll-x my-4">
              <table {...props}>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
