/**
 * The kit's contract (7.0, quiet-console phase 1): what the light barrel
 * carries and what it never does, each primitive mounted once, the row's
 * expand, and the family's axe.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import {
  Banner,
  Button,
  ButtonGroup,
  Duration,
  Empty,
  Input,
  Kbd,
  KbdChord,
  KeyValue,
  Label,
  Money,
  Mono,
  Page,
  RelativeTime,
  Row,
  SectionHeading,
  Skeleton,
  Spinner,
  buttonVariants,
  isoDuration,
} from './index';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const BARREL = readFileSync(here('./index.ts'), 'utf8');

describe('the light barrel', () => {
  it('re-exports no heavy piece — each is imported by path', () => {
    for (const heavy of [
      'dialog',
      'sheet',
      'popover',
      'dropdown',
      'command',
      'tooltip',
      'select',
      'combobox',
      'tabs',
      'table',
      'markdown',
      'disclosure',
      'inspector',
      'toolbar',
      'data-list',
      'status/',
      'track/',
      'grid/',
    ]) {
      expect(BARREL, heavy).not.toMatch(new RegExp(`from '\\./${heavy.replace('/', '\\/')}`));
    }
    // …and the heavy pieces exist where the plan put them.
    const files = readdirSync(here('.'));
    for (const name of [
      'dialog',
      'sheet',
      'popover',
      'dropdown',
      'command',
      'tooltip',
      'select',
      'combobox',
      'tabs',
      'table',
      'markdown',
      'disclosure',
      'inspector',
      'toolbar',
      'data-list',
    ]) {
      expect(files, name).toContain(`${name}.tsx`);
    }
    // The grid is a folder of its own, and its engine is a chunk of its own.
    expect(readdirSync(here('./grid'))).toEqual(
      expect.arrayContaining(['grid.tsx', 'engine.ts', 'column.ts']),
    );
  });

  it('carries the names the plan lists, and the Everything key', () => {
    for (const name of [
      'Button',
      'Kbd',
      'Mono',
      'Skeleton',
      'Empty',
      'Spinner',
      'Banner',
      'toast',
      'field',
      'fieldSurface',
      'Input',
      'Label',
      'SectionHeading',
      'KeyValue',
      'Page',
      'Row',
      'RelativeTime',
      'Duration',
      'Money',
      'EVERYTHING_PREF',
      'useEverything',
    ]) {
      expect(BARREL, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('spells no capital label, no tracked-out eyebrow, no second face and no card shadow anywhere in the kit', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(here('.'))) {
      if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue;
      const text = readFileSync(here(`./${name}`), 'utf8');
      for (const bad of [
        /\buppercase\b/,
        /\btracking-\[/,
        /\bfont-display\b/,
        /\bshadow-card\b/,
        /\bshadow-action\b/,
      ]) {
        if (bad.test(text)) offenders.push(`${name}: ${bad.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is the one form layer of the launch: no native select, input, button or textarea in screens/launch', () => {
    // A hand-rolled control is a second look and a second set of touch, focus
    // and size rules; the kit's controls carry them once. The launch form is
    // the console's largest form, so it is held to it file by file (comments
    // stripped: a sentence about a `<select>` is not one).
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${dir}/${entry.name}`)
          : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)
            ? [`${dir}/${entry.name}`]
            : [],
      );
    const files = walk(here('../screens/launch'));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      return [...text.matchAll(/<(select|input|button|textarea)\b/g)].map(
        (match) => `${path.split('/screens/launch/')[1]}: <${match[1]}>`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('has no amber button: the primary is ink-solid and the danger is the failed hue', () => {
    expect(buttonVariants({ variant: 'primary' })).toMatch(/\bbg-action\b/);
    expect(buttonVariants({ variant: 'primary' })).toMatch(/\btext-ground\b/);
    for (const variant of ['default', 'primary', 'ghost', 'danger'] as const) {
      expect(buttonVariants({ variant })).not.toMatch(/accent|needs-you/);
      expect(buttonVariants({ variant })).toMatch(/min-h-\(--tap-min\)/);
    }
  });
});

describe('the primitives mount, and read right to a screen reader', () => {
  it('a page of everything has no axe violation', async () => {
    const { container } = render(
      <Page
        title="Runs"
        lead="2 need you, 1 running"
        actions={<Button variant="primary">Start a run</Button>}
      >
        <SectionHeading count={3} aside={<Button size="sm">View</Button>}>
          Running
        </SectionHeading>
        <Row
          mark={<span data-status="running">Running</span>}
          name="quiet-console"
          href="#"
          fact="phase 1 of 35"
          clock={<Duration ms={754_000} />}
          action={<Button size="sm">Open</Button>}
          paint="running"
          expandLabel="Phases"
        >
          <KeyValue
            items={[
              ['Branch', <Mono key="b" value="pe/quiet-console" />],
              ['Spent', <Money key="m" usd={12.5} against={150} />],
              ['Started', <RelativeTime key="t" at={Date.now() - 60_000} live={false} />],
              ['Nothing', null],
            ]}
          />
        </Row>
        <Banner severity="warn" action={<Button size="sm">Try again</Button>}>
          The read failed and said nothing.
        </Banner>
        <Empty title="No runs yet." action={<Button size="sm">Start one</Button>} />
        <Spinner />
        <Skeleton className="h-4 w-24" />
        <div>
          <Label htmlFor="q" hint="Plans, runs, phases">
            Search
          </Label>
          <Input id="q" block placeholder="Type to find" />
        </div>
        <ButtonGroup>
          <Button aria-pressed>List</Button>
          <Button>Table</Button>
        </ButtonGroup>
        <p>
          Press <KbdChord keys={['⌘', 'K']} /> or <Kbd>/</Kbd>.
        </p>
      </Page>,
    );
    await expectNoAxeViolations(container);
  });

  it('a row expands in place, names what it shows, and unmounts what it hides', () => {
    render(
      <Row mark={<span>•</span>} name="plan" expandLabel="Phases">
        <p>thirty-five phases</p>
      </Row>,
    );
    const button = screen.getByRole('button', { name: 'Show phases' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('thirty-five phases')).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAccessibleName('Hide phases');
    expect(screen.getByText('thirty-five phases').closest('.expand-region')).not.toBeNull();
    fireEvent.click(button);
    expect(screen.queryByText('thirty-five phases')).toBeNull();
  });

  it('a name inside the expand label keeps its capitals — only the first letter follows the verb', () => {
    render(
      <Row mark={<span>•</span>} name="Docs" expandLabel="details of Docs">
        <p>its tools</p>
      </Row>,
    );
    expect(screen.getByRole('button', { name: 'Show details of Docs' })).toBeInTheDocument();
  });

  it('a row wears its paint on its leading edge, through the state class', () => {
    const { container } = render(<Row mark={<span>•</span>} name="x" paint="needs-you" />);
    const row = container.querySelector('[data-row]')!;
    expect(row.className).toContain('state-needs-you');
    expect(row.className).toContain('border-state');
    expect(row.getAttribute('style')).toBeNull();
  });

  it('a row with nothing to expand draws no toggle', () => {
    render(<Row mark={<span>•</span>} name="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('money, durations and clocks are the sans with tabular numerals, never mono; a machine value is mono', () => {
    const { container } = render(
      <div>
        <Money usd={3} />
        <Duration ms={61_000} />
        <RelativeTime at={0} live={false} />
        <Mono value="af1cadb3f7e2" chars={8} />
      </div>,
    );
    const [money, duration, time] = [...container.querySelectorAll('span, time')].slice(0, 3);
    for (const el of [money, duration, time]) {
      expect(el!.className).toContain('tnum');
      expect(el!.className).not.toContain('font-mono');
    }
    const mono = container.querySelector('code')!;
    expect(mono.className).toContain('font-mono');
    expect(mono.textContent).toBe('af1cadb3');
    expect(mono.getAttribute('title')).toBe('af1cadb3f7e2');
    expect(container.querySelector('time')!.getAttribute('dateTime')).toBe('PT1M1S');
    expect(isoDuration(3_723_000)).toBe('PT1H2M3S');
  });

  it('a command drawn as words wraps between them, never inside a flag, and copies whole', () => {
    const line = 'phase-console capability root add --allow-publish';
    const { container } = render(<Mono value={line} copyable words />);
    const words = [...container.querySelectorAll('code > span')].map((span) => span.textContent);
    expect(words).toEqual(['phase-console', 'capability', 'root', 'add', '--allow-publish']);
    for (const span of container.querySelectorAll('code > span'))
      expect(span.className).toContain('inline-block');
    expect(container.querySelector('code')!.textContent).toBe(line);
    expect(screen.getByRole('button')).toHaveAttribute('title', `${line} — press to copy`);
  });

  it('money over its budget reads in the failed hue, and under it does not', () => {
    const { container } = render(
      <div>
        <Money usd={151} against={150} />
        <Money usd={12} against={150} />
      </div>,
    );
    const [over, under] = container.querySelectorAll('span');
    expect(over!.className).toContain('text-failed');
    expect(over!.getAttribute('title')).toMatch(/over/);
    expect(under!.className).not.toContain('text-failed');
  });

  it('a key-value list drops empty rows and vanishes when nothing is left', () => {
    const { container } = render(<KeyValue items={[['a', ''], ['b', null], false, undefined]} />);
    expect(container.innerHTML).toBe('');
  });

  it('a copyable value shares its label’s line on touch, and keeps a real thumb floor', () => {
    // Logs ▸ Health ▸ This process ▸ Serving build, measured at 360 and 768:
    // the value's text sat centred in its 44 px box, 13 px under its label.
    // Pinned as classes because jsdom lays nothing out (quiet-console phase 27).
    const { container } = render(
      <KeyValue
        items={[
          ['Serving build', <Mono key="b" value="af1cadb3f7e2c4d5" chars={12} copyable />],
          ['Command', <Mono key="c" value="phase-console update pe-hub --when-idle" copyable words />],
          ['Platform', 'darwin arm64'],
        ]}
      />,
    );
    // Each row's label and value share a baseline: the label sits on the
    // value's FIRST line, one line or wrapped.
    expect(container.querySelector('dl')!.className).toMatch(/(?:^|\s)items-baseline(?:\s|$)/);
    const copies = screen.getAllByRole('button');
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy).toHaveAttribute('data-copy');
      // The floor is the BOX: stacked values take no overlay that would reach
      // the rows around them (design.md §6)…
      expect(copy.className).toContain('[@media(hover:none)]:min-h-(--tap-min)');
      expect(copy.className).not.toMatch(/\btap-(?:area|line)\b/);
      // …and its value writes its text at the box's top, so the height hangs below.
      expect(copy.closest('dd')!.className).toContain('[&_[data-copy]]:items-start');
    }
    // The label is one line of meta type, never a box of its own.
    for (const label of container.querySelectorAll('dt')) {
      expect(label.className).not.toMatch(/min-h|items-center|\bflex\b/);
    }
    // Anywhere else a copyable value stays centred in its box — on a table
    // row's line, or a sentence's.
    const { container: alone } = render(<Mono value="af1cadb3" copyable />);
    expect(alone.querySelector('[data-copy]')!.className).toMatch(/(?:^|\s)items-center(?:\s|$)/);
  });
});

describe('a menu fits the screen it opens on (#315)', () => {
  it('caps its width at the space Radix measures beside its trigger, not at its own width', async () => {
    const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } =
      await import('./dropdown');
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>{'A very long console name '.repeat(12)}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = await screen.findByRole('menu');
    // `100%` inside Radix's content-sized wrapper is the menu's own width, so
    // it never capped anything; the measured available width does.
    expect(menu.className).toContain('max-w-(--radix-dropdown-menu-content-available-width)');
    expect(menu.className).not.toContain('calc(100%');
  });
});
