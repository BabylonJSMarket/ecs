import { type Component, For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import { vizStore, installVizKeyboard, uninstallVizKeyboard } from './vizStore';
import { VizPanel } from './VizPanel';

const DOCK_GAP = 10;

// Grab area sits in the gutter just outside the dock column. Transparent until
// it's been hovered for HOVER_DELAY, then it highlights and widens — growing
// into the empty gutter (away from the panels), so it never covers them.
const RESIZER_GRAB = 8;
const RESIZER_ACTIVE_W = 12;
const HOVER_DELAY = 150;

/** Draggable splitter that resizes a whole dock column (all panels in it). */
const DockResizer: Component<{ side: 'left' | 'right' }> = (props) => {
  const [iw, setIw] = createSignal(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const [active, setActive] = createSignal(false);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const hasDocked = () =>
    Object.values(vizStore.panels).some((p) => p.visible && p.dock === props.side);

  onMount(() => {
    const onResize = () => setIw(window.innerWidth);
    window.addEventListener('resize', onResize);
    onCleanup(() => window.removeEventListener('resize', onResize));
  });
  onCleanup(() => {
    if (hoverTimer) clearTimeout(hoverTimer);
  });

  const onEnter = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setActive(true), HOVER_DELAY);
  };
  const onLeave = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    setActive(false);
  };

  const onDown = (e: MouseEvent) => {
    e.preventDefault();
    setActive(true);
    const move = (ev: MouseEvent) => {
      const w =
        props.side === 'left'
          ? ev.clientX - DOCK_GAP
          : window.innerWidth - ev.clientX - DOCK_GAP;
      vizStore.setDockWidth(props.side, w);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const w = () => (active() ? RESIZER_ACTIVE_W : RESIZER_GRAB);
  // Anchor at the column's inner edge; widen into the gutter (left dock grows
  // right, right dock grows left) so the handle never overlaps the panels.
  const left = () =>
    props.side === 'left'
      ? vizStore.getDockWidth('left') + DOCK_GAP
      : iw() - vizStore.getDockWidth('right') - DOCK_GAP - w();

  return (
    <Show when={hasDocked()}>
      <div
        class={`viz-dock-resizer viz-dock-resizer--${props.side}`}
        onMouseDown={onDown}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        style={{
          position: 'fixed',
          top: '0',
          bottom: '0',
          left: `${left()}px`,
          width: `${w()}px`,
          cursor: 'col-resize',
          'z-index': '20000',
          background: active() ? 'var(--viz-accent, #66ccff)' : 'transparent',
          opacity: active() ? '0.8' : '1',
          transition: 'width 120ms ease, background 120ms ease',
        }}
      />
    </Show>
  );
};

export const VizRoot: Component = () => {
  return (
    <>
      <For each={Object.values(vizStore.panels)}>
        {(panel) => (
          <Show when={panel.visible}>
            <VizPanel panel={panel} />
          </Show>
        )}
      </For>
      <DockResizer side="left" />
      <DockResizer side="right" />
    </>
  );
};

let mounted = false;
let disposeRoot: (() => void) | null = null;

export function mountVizRoot(): void {
  if (mounted) return;

  const container = document.createElement('div');
  container.id = 'viz-root';
  document.body.appendChild(container);

  disposeRoot = render(() => <VizRoot />, container);
  installVizKeyboard();
  mounted = true;
}

export function unmountVizRoot(): void {
  if (!mounted || !disposeRoot) return;

  disposeRoot();
  uninstallVizKeyboard();
  const container = document.getElementById('viz-root');
  if (container) {
    container.remove();
  }

  disposeRoot = null;
  mounted = false;
}
