import { ExternalLink } from './ExternalLink';
import { licenseUrl, licenseWords } from './notices';

/** An SPDX expression in words, "MIT oder Apache-2.0", with a link to each licence text. */
export function LicenseLinks({ expression }: { expression: string }) {
  return (
    <>
      {licenseWords(expression).map((w, i) => {
        const href = w.licence ? licenseUrl(w.text) : undefined;
        return href ? (
          <ExternalLink href={href} key={i}>
            {w.text}
          </ExternalLink>
        ) : (
          w.text
        );
      })}
    </>
  );
}
