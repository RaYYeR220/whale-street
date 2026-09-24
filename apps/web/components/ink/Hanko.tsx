export type HankoTone = 'red' | 'blue' | 'ink';

export function Hanko({
  kanji,
  word,
  tone = 'red',
  stamping = false,
  className,
  label,
}: {
  kanji: string;
  word?: string;
  tone?: HankoTone;
  stamping?: boolean;
  className?: string;
  label: string;
}) {
  const cls = [
    'ws-hanko',
    tone === 'blue' ? 'ws-hanko--blue' : '',
    tone === 'ink' ? 'ipo-hanko--ink' : '',
    stamping ? 'is-stamping' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} role="img" aria-label={label}>
      <span className="ws-hanko__kanji" aria-hidden="true">
        {kanji}
      </span>
      {word ? (
        <span className="ws-hanko__word" aria-hidden="true">
          {word}
        </span>
      ) : null}
    </span>
  );
}
