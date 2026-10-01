import type { ReactNode } from 'react';

/**
 * Minimal, safe Markdown renderer for summaries and transcripts: headings, bullets (nested by
 * indent), bold/italic/code, rules and paragraphs. Builds React elements, never raw HTML.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Item {
  text: string;
  children: Item[];
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.split('\n');
  let para: string[] = [];
  let list: { indent: number; items: Item[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    para = [];
  };
  const renderItems = (items: Item[]): ReactNode => (
    <ul>
      {items.map((it, i) => (
        <li key={i}>
          {inline(it.text)}
          {it.children.length > 0 && renderItems(it.children)}
        </li>
      ))}
    </ul>
  );
  const flushList = () => {
    if (list) blocks.push(<div key={blocks.length}>{renderItems(list.items)}</div>);
    list = null;
  };
  const stack: { indent: number; items: Item[] }[] = [];

  for (const raw of lines) {
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      flushPara();
      const indent = bullet[1]!.length;
      if (!list) {
        list = { indent, items: [] };
        stack.length = 0;
        stack.push(list);
      }
      // Close deeper levels, then open a nested level if this bullet is indented further.
      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
      let top = stack[stack.length - 1]!;
      if (indent > top.indent && top.items.length) {
        top = { indent, items: top.items[top.items.length - 1]!.children };
        stack.push(top);
      }
      top.items.push({ text: bullet[2]!, children: [] });
      continue;
    }
    if (list && /^\s+\S/.test(raw)) {
      const last = stack[stack.length - 1]!.items.at(-1);
      if (last) last.text += ` ${raw.trim()}`;
      continue;
    }
    flushList();
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) {
      flushPara();
      const level = Math.min(h[1]!.length + 1, 5);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={blocks.length}>{inline(h[2]!)}</Tag>);
    } else if (/^\s*---+\s*$/.test(raw)) {
      flushPara();
      blocks.push(<hr key={blocks.length} />);
    } else if (!raw.trim()) {
      flushPara();
    } else {
      para.push(raw.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="markdown">{blocks}</div>;
}
