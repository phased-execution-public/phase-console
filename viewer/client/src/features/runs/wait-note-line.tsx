/**
 * What a waiting run waits on and when it resumes, under its status word
 * (control-tower phase 88, #148) — "on phase 28 · gh:acme/web#run/1 · resumes
 * 08:57Z". The word alone read like somebody's pause, and two runs asleep on
 * their own clocks were asked about as if an operator had stopped them.
 */
export function WaitNoteLine({ note }: { note: string }) {
  return (
    <div className="mt-0.5 max-w-[18rem] truncate text-2xs text-ink-faint" title={note}>
      {note}
    </div>
  );
}
