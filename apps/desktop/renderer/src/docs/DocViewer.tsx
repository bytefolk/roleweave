import { useId, type ReactNode } from "react";
import { Tag } from "antd";
import { useT } from "@roleweave/ui";
import { Markdown, markdownHeadings } from "../markdown/Markdown";
import { splitFrontmatter } from "./frontmatter";

function stripExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

export interface DocViewerProps {
  source: string;
  /** Reference provenance, not an editable revision history. */
  version?: string;
  updatedAt?: string;
  title?: string;
  /** Position file type; shared previews default to Markdown. */
  path?: string;
  actions?: ReactNode;
}
const META_LABEL_KEYS: Record<string, string> = {
  name: "docs.metaName",
  description: "docs.metaDescription",
};

export function DocViewer({
  source,
  version,
  updatedAt,
  title,
  path,
  actions,
}: DocViewerProps) {
  const t = useT();
  const headingPrefix = `document-${useId().replaceAll(":", "")}`;
  const extension = path?.split(".").pop()?.toLowerCase();
  const isMarkdown =
    !extension || extension === "md" || extension === "markdown";
  const { data, body, hasFrontmatter } = isMarkdown
    ? splitFrontmatter(source)
    : {
        data: {} as Record<string, string>,
        body: source,
        hasFrontmatter: false,
      };
  const heading = title ?? data.name ?? t("docs.untitled");
  const displayHeading = stripExtension(heading);
  const metaEntries = Object.entries(data).filter(([key]) => key !== "name");
  const headings = isMarkdown ? markdownHeadings(body, headingPrefix) : [];
  const time =
    updatedAt ??
    (version && Number.isFinite(Date.parse(version)) ? version : undefined);
  const formattedTime = time
    ? new Date(time).toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : undefined;
  return (
    <article className="owb-doc-viewer">
      <header className="owb-doc-viewer__toolbar">
        <div className="owb-doc-viewer__location">
          <strong title={heading}>{displayHeading}</strong>
          <span>
            {formattedTime ? (
              <time dateTime={time}>
                {t("reading.updatedAt", {
                  time: formattedTime,
                })}
              </time>
            ) : version ? (
              t("reading.referenceVersion", { version })
            ) : null}
          </span>
        </div>
        <Tag>{t("reading.preview")}</Tag>
        {actions}
      </header>
      <div className="owb-doc-viewer__page">
        {headings.length >= 3 && (
          <details className="owb-doc-viewer__toc">
            <summary>{t("reading.contents")}</summary>
            <nav aria-label={t("reading.contents")}>
              {headings.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  style={{ paddingInlineStart: (item.level - 1) * 12 }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.currentTarget
                      .closest("article")
                      ?.querySelector(`[id="${item.id}"]`)
                      ?.scrollIntoView({ block: "start" });
                  }}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </details>
        )}
        {hasFrontmatter && metaEntries.length > 0 && (
          <dl className="owb-doc-viewer__meta">
            {metaEntries.map(([key, value]) => (
              <div key={key}>
                <dt>
                  {META_LABEL_KEYS[key] !== undefined
                    ? t(META_LABEL_KEYS[key])
                    : key}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="owb-doc-viewer__body">
          {isMarkdown ? (
            <Markdown content={body} headingPrefix={headingPrefix} />
          ) : extension === "txt" ? (
            <div className="owb-doc-viewer__text">{source}</div>
          ) : (
            <pre className="owb-doc-viewer__code">
              <code className={`language-${extension}`}>{source}</code>
            </pre>
          )}
        </div>
      </div>
    </article>
  );
}
