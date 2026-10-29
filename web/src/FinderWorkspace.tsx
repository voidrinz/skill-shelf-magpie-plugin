import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as HoverCard from '@radix-ui/react-hover-card';
import FinderTooltip from './ShelfTooltip';
import { ArrowDown, ArrowUpDown, CircleAlert, CircleArrowUp, CircleCheck, CircleDashed, CircleHelp, CircleX, Boxes, Braces, ChevronDown, ChevronRight, ChevronUp, Columns3, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, Grid2X2, HardDrive, Info, Languages, Link2, List, LoaderCircle, PackagePlus, PencilLine, RefreshCw, Rocket, Sparkles, Trash2 } from 'lucide-react';
import { ContextMenu, DropdownMenu, PositionedMenu } from './ShelfMenu';
import { useAiPreferences } from './ai-preferences';
import type { AiAnnotation, FinderMove, Folder, ManagedSkill, Position, Skill, Snapshot, ViewMode } from './types';
import { applySelection, availablePosition, defaultCanvasPosition, defaultFinderOptions, descendantIds, draggedCanvasPositions, finderGroups, finderItems, folderChain, gridPosition, intersects, movableItems, nextCanvasPosition, orderItems, selectedSkillIds, selectRange, type FinderItem, type FinderOptions, type SortKey } from './finder-state';

type Props = {
  snapshot: Snapshot; annotations: Record<string, AiAnnotation>; scope: string; folderId: string | null; title: string; query: string;
  view: ViewMode; busy: boolean; selection: string[]; onSelection: (keys: string[]) => void;
  onNavigate: (folderId: string | null) => void; onOpenSkill: (skill: Skill | ManagedSkill) => void; onCloseSkill?: () => void;
  onCreateFolder: (position?: Position) => void; onEditFolder: (folder: Folder) => void;
  onOpenFolder: (id: string) => void; onTranslate: (ids: string[]) => void;
  onOrganizeSkill: (skill: ManagedSkill) => void; onDeleteFolder: (folder: Folder) => void;
  onImport: (ids: string[]) => void; onDeploy: (ids: string[]) => void;
  onDeleteSkill: (skill: ManagedSkill) => void;
  onCommit: (move: FinderMove) => Promise<boolean>; onView: (view: ViewMode) => void;
  finderOptions?: FinderOptions; onFinderOptionsChange?: (next: FinderOptions) => void;
  selectedSkillId?: string | null;
  matchingIds?: Set<string> | null;
  updateChecks?: Record<string, UpdateCheck>;
  updatingSkillIds?: string[];
  staleTranslationIds?: string[];
  onUpdate?: (ids: string[]) => void;
};
const sortLabels: Record<SortKey, string> = { manual: '无', name: '名称', kind: '种类', source: '来源', tags: '标签' };
type Context = { x: number; y: number; point?: Position; item?: FinderItem; keys: string[] };
type Rect = { x: number; y: number; width: number; height: number };
type UpdateCheck = { status: string; reason: string; checkedAt?: string };
type InstallationMetadata = { installKind?: 'directory' | 'symlink' | 'unknown'; linkTarget?: string; sourceUrl?: string };
const updateLabels: Record<string, string> = { current: '已是最新', 'update-available': '可更新', missing: '上游已移除', unavailable: '无法确认', unchecked: '待确认' };
const updateGlyphs = { current: CircleCheck, 'update-available': CircleArrowUp, missing: CircleX, unavailable: CircleHelp, unchecked: CircleDashed };
const updateReasons: Record<string, string> = {
  'up-to-date': '这个 Skill 已是最新版本。', 'remote-changed': '上游 Skill 目录在安装后发生了变化。',
  'remote-missing': '记录的 Skill 目录已不在上游仓库中。', 'local-source': '本地 Skill 没有可供比较的上游版本。',
  untracked: '无法识别当前安装的版本。', 'unsupported-source': '当前来源类型暂不支持自动检查。',
  'source-unavailable': '仓库可能是私有的、暂时不可访问，或已经删除。', 'network-error': '暂时无法检查上游来源，请稍后重试。',
};
const emptyCheck: UpdateCheck = { status: 'unchecked', reason: 'not-scanned' };
function updateCheckFresh(check: UpdateCheck) {
  const checkedAt = Date.parse(check.checkedAt || '');
  return check.status !== 'unchecked' && Number.isFinite(checkedAt) && Date.now() - checkedAt <= 30 * 60_000;
}
function installationDetails(skill?: Skill | ManagedSkill) {
  const metadata = skill as (Skill & InstallationMetadata) | undefined;
  const kind = skill && 'packId' in skill ? 'directory' : metadata?.installKind || 'unknown';
  return { kind, linkTarget: metadata?.linkTarget, Icon: kind === 'symlink' ? Link2 : kind === 'directory' ? FolderOpen : CircleHelp, label: kind === 'symlink' ? '软链接' : kind === 'directory' ? '实际目录' : '目录类型未知' };
}
function skillSource(item: FinderItem) {
  return item.skill && 'packId' in item.skill ? item.skill.sourcePath : (item.skill as (Skill & InstallationMetadata) | undefined)?.sourceUrl || item.source || '本地 Skill';
}
const contextSortChoices: [SortKey, string][] = [['name', '名称'], ['kind', '种类'], ['source', '来源'], ['tags', '标签']];

function loadOptions(location: string): FinderOptions {
  try { return { ...defaultFinderOptions, ...JSON.parse(localStorage.getItem(`shelf-finder:${location}`) || '{}') }; } catch { return defaultFinderOptions; }
}

export default function FinderWorkspace(props: Props) {
  const aiPreferences = useAiPreferences();
  const { snapshot, scope, folderId, title, query, view, busy, selection, onSelection, onNavigate, onOpenSkill, onCommit } = props;
  const location = `${scope}:${folderId || 'root'}`;
  const [localOptions, setOptions] = useState<FinderOptions>(() => loadOptions(location));
  const options = props.finderOptions || localOptions;
  const [savingOptions, setSavingOptions] = useState(false);
  const arrangementCommit = useRef(false);
  const [width, setWidth] = useState(850);
  const [context, setContext] = useState<Context | null>(null);
  const [preview, setPreview] = useState<Record<string, Position>>({});
  const [box, setBox] = useState<Rect | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [arrangementTarget, setArrangementTarget] = useState<HTMLElement | null>(null);
  const [arrangement, setArrangement] = useState<'group' | 'sort' | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const selectionLayer = useRef<SVGSVGElement>(null);
  const selectionRectangle = useRef<SVGRectElement>(null);
  const positionCache = useRef(new Map<string, Position>());
  const anchor = useRef<string | null>(null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const suppressedClick = useRef(new Set<string>());
  const drag = useRef<{
    pointer: number; start: Position; moved: boolean; keys: string[]; anchorKey: string; capture: HTMLElement;
    origins: Record<string, Position>; positions: Record<string, Position>; target: string | null;
  } | null>(null);
  const rubber = useRef<{ pointer: number; start: Position; base: string[]; mode: 'replace' | 'add' | 'toggle'; active: boolean; next: string[]; capture: HTMLElement } | null>(null);
  const allItems = useMemo(() => finderItems(snapshot, scope).filter(item => !props.matchingIds || item.kind === 'folder' || props.matchingIds.has(item.id)), [snapshot, scope, props.matchingIds]);
  const folders = useMemo(() => snapshot.folders.filter(folder => folder.scopeId === scope), [snapshot, scope]);
  const chain = folderChain(folderId, folders);
  const filtering = Boolean(query.trim() || props.matchingIds);
  const iconView = view === 'grid';
  const canvas = iconView && !filtering;
  const activeGroup = filtering ? 'manual' : options.group;
  const matched = allItems.filter(item => filtering
    ? (item.kind === 'skill' || scope.startsWith('pack:')) && [item.name, item.source, ...item.tags, item.skill?.description || '', props.annotations[item.id]?.stale ? '' : props.annotations[item.id]?.text || ''].join(' ').toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))
    : item.parentId === folderId);
  const effectiveOptions = { ...options, sort: options.sort === 'manual' && (!canvas || activeGroup !== 'manual') ? 'name' as const : options.sort };
  const ordered = canvas && options.sort === 'manual' && options.group === 'manual' ? matched : orderItems(matched, effectiveOptions);
  const free = canvas && !filtering && options.sort === 'manual' && options.group === 'manual';
  const [groups, positions, headings] = useMemo(() => {
    const groups = finderGroups(ordered, activeGroup);
    const result: Record<string, Position> = {}; const headings: { label: string; y: number; count: number }[] = [];
    const occupied: Position[] = [];
    if (free) {
      for (const item of ordered) {
        const stored = snapshot.finderPositions?.[item.key] || positionCache.current.get(`${location}:${item.key}`);
        if (stored) { result[item.key] = stored; occupied.push(stored); }
      }
      for (const item of ordered) {
        const cacheKey = `${location}:${item.key}`;
        if (result[item.key]) { positionCache.current.set(cacheKey, result[item.key]); continue; }
        const point = positionCache.current.get(cacheKey) || nextCanvasPosition(occupied);
        result[item.key] = point; occupied.push(point); positionCache.current.set(cacheKey, point);
      }
    } else {
      let top = activeGroup === 'manual' ? 24 : 18;
      for (const [label, members] of groups) {
        if (label) headings.push({ label, y: top, count: members.length });
        members.forEach((item, index) => { const point = gridPosition(index, width); result[item.key] = { x: point.x, y: point.y - 24 + top + (label ? 34 : 0) }; });
        top += gridPosition(Math.max(0, members.length - 1), width).y - 24 + 122 + (label ? 34 : 0);
      }
    }
    return [groups, result, headings] as const;
  }, [allItems, props.annotations, folderId, query, snapshot.finderPositions, options, free, width]);

  useEffect(() => { if (!props.finderOptions) setOptions(loadOptions(location)); anchor.current = null; setPreview({}); setBox(null); setContext(null); setArrangement(null); }, [location]);
  useEffect(() => { setArrangementTarget(document.getElementById('finder-arrangement-controls')); }, []);
  useEffect(() => {
    const element = container.current; if (!element) return;
    const resize = () => setWidth(element.clientWidth);
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    if (view === 'columns') container.current?.querySelector('.finder-column-panel:last-child')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [folderId, view]);

  const changeOptions = (patch: Partial<FinderOptions>) => {
    const next = { ...options, ...patch, ...(patch.group && patch.group !== 'manual' ? { groupBy: patch.group } : {}) };
    if (props.finderOptions) { props.onFinderOptionsChange?.(next); return; }
    setOptions(next);
    localStorage.setItem(`shelf-finder:${location}`, JSON.stringify(next));
  };
  const selectionMode = (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => event.ctrlKey || event.metaKey ? 'toggle' as const : event.shiftKey ? 'add' as const : 'replace' as const;
  const commitSelection = (keys: string[]) => {
    const next = [...new Set(keys)];
    if (next.length === selectionRef.current.length && next.every(key => selectionRef.current.includes(key))) return;
    selectionRef.current = next; onSelection(next);
  };
  const selectItem = (event: ReactMouseEvent, item: FinderItem, order: string[]) => {
    if (suppressedClick.current.has(item.key)) { suppressedClick.current.delete(item.key); event.preventDefault(); event.stopPropagation(); return; }
    const extendsRange = event.shiftKey && !canvas;
    const candidates = extendsRange ? selectRange(order, anchor.current, item.key) : [item.key];
    const mode = extendsRange ? event.ctrlKey || event.metaKey ? 'add' : 'replace' : selectionMode(event);
    commitSelection(applySelection(selectionRef.current, candidates, mode));
    if (!event.shiftKey) anchor.current = item.key;
  };
  const openContext = (event: ReactMouseEvent, item?: FinderItem) => {
    event.preventDefault(); event.stopPropagation();
    const keys = item ? selectionRef.current.includes(item.key) ? selectionRef.current : [item.key] : [];
    if (item) { commitSelection(keys); closeOtherSelection(keys); anchor.current = item.key; }
    const bounds = container.current?.getBoundingClientRect();
    const point = canvas && bounds ? {
      x: Math.min(100000, Math.max(12, event.clientX - bounds.left + container.current!.scrollLeft)),
      y: Math.min(100000, Math.max(12, event.clientY - bounds.top + container.current!.scrollTop)),
    } : undefined;
    setArrangement(null);
    setContext({ x: event.clientX, y: event.clientY, point, item, keys });
  };
  const pointInSurface = (event: ReactPointerEvent): Position => {
    const bounds = (canvas ? surface.current : container.current)!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top + (canvas ? 0 : container.current!.scrollTop) };
  };
  const itemPointerDown = (event: ReactPointerEvent, item: FinderItem) => {
    if (!canvas || busy || filtering || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('input, .skill-row-quick-button')) return;
    const selectedKeys = selectionRef.current.includes(item.key) ? selectionRef.current : [item.key];
    const keys = ordered.filter(candidate => selectedKeys.includes(candidate.key)).map(candidate => candidate.key);
    const origins = Object.fromEntries(keys.map(key => [key, positions[key]]));
    if (!origins[item.key]) return;
    drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, keys, anchorKey: item.key, capture: event.currentTarget as HTMLElement, origins, positions: origins, moved: false, target: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const closeOtherSelection = (keys: string[]) => { if (keys.length !== 1 || keys[0] !== `skill:${props.selectedSkillId}`) props.onCloseSkill?.(); };
  const moveTo = async (keys: string[], parentId: string | null) => {
    if (busy) return false;
    const items = movableItems(keys, allItems, folders);
    const excluded = descendantIds(items.filter(item => item.kind === 'folder').map(item => item.id), folders);
    if (parentId && excluded.has(parentId)) return false;
    const moving = new Set(items.map(item => item.key));
    const occupied = allItems.filter(item => item.parentId === parentId && !moving.has(item.key)).map((item, index) => snapshot.finderPositions?.[item.key] || positionCache.current.get(`${scope}:${parentId || 'root'}:${item.key}`) || defaultCanvasPosition(index));
    const updates = items.map(item => {
      const position = nextCanvasPosition(occupied); occupied.push(position);
      return { kind: item.kind, id: item.id, position };
    });
    if (updates.length && await onCommit({ scopeId: scope, items: updates, parentId })) { commitSelection([]); props.onCloseSkill?.(); return true; }
    return false;
  };
  const finishDrag = async (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null; setDropTarget(null);
    if (current.capture.hasPointerCapture(event.pointerId)) current.capture.releasePointerCapture(event.pointerId);
    if (!current.moved) return;
    suppressedClick.current.add(current.anchorKey);
    try {
      if (current.target !== null) {
        await moveTo(current.keys, current.target === '__root__' ? null : current.target);
      } else if (free) {
        const occupied = ordered.filter(item => !current.keys.includes(item.key)).map(item => positions[item.key]);
        const items = current.keys.flatMap(key => {
          const item = allItems.find(item => item.key === key); const point = current.positions[key]; if (!item || !point) return [];
          const position = options.snap ? availablePosition(point, occupied) : point; occupied.push(position);
          return [{ kind: item.kind, id: item.id, position }];
        });
        if (items.length && await onCommit({ scopeId: scope, items })) { commitSelection(current.keys); closeOtherSelection(current.keys); }
      }
    } finally { setPreview({}); }
  };
  const pointerMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (current && current.pointer === event.pointerId) {
      const dx = event.clientX - current.start.x; const dy = event.clientY - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < 4) return;
      if (!current.moved) { current.moved = true; commitSelection(current.keys); closeOtherSelection(current.keys); }
      current.positions = draggedCanvasPositions(current.origins, current.anchorKey, current.start, { x: event.clientX, y: event.clientY }, free);
      setPreview(current.positions);
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-finder-folder-id]');
      const id = target?.dataset.finderFolderId || null;
      current.target = id && !current.keys.includes(`folder:${id}`) ? id : null; setDropTarget(current.target);
      return;
    }
    const currentBox = rubber.current;
    if (!currentBox || currentBox.pointer !== event.pointerId) return;
    const point = pointInSurface(event);
    if (!currentBox.active && Math.hypot(point.x - currentBox.start.x, point.y - currentBox.start.y) < 4) return;
    currentBox.active = true;
    const rectangle = { x: Math.min(point.x, currentBox.start.x), y: Math.min(point.y, currentBox.start.y), width: Math.abs(point.x - currentBox.start.x), height: Math.abs(point.y - currentBox.start.y) };
    const bounds = (canvas ? surface.current : container.current)!.getBoundingClientRect();
    const keys = Array.from(container.current!.querySelectorAll<HTMLElement>('[data-finder-item-key]')).filter(element => {
      const rect = element.getBoundingClientRect();
      return intersects(rectangle, { x: rect.left - bounds.left, y: rect.top - bounds.top + (canvas ? 0 : container.current!.scrollTop), width: rect.width, height: rect.height });
    }).map(element => element.dataset.finderItemKey!);
    currentBox.next = applySelection(currentBox.base, keys, currentBox.mode);
    container.current?.querySelectorAll<HTMLElement>('[data-finder-item-key]').forEach(element => {
      const selected = String(currentBox.next.includes(element.dataset.finderItemKey!));
      element.dataset.boxSelected = selected;
      const folderButton = element.querySelector<HTMLElement>('.finder-list-folder');
      if (folderButton) folderButton.dataset.boxSelected = selected;
    });
    if (canvas) {
      for (const [attribute, value] of Object.entries(rectangle)) selectionRectangle.current?.setAttribute(attribute, String(value));
      selectionLayer.current?.setAttribute('data-active', 'true');
    } else setBox(rectangle);
    event.preventDefault();
  };
  const backgroundDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('[data-finder-item-key],button,input,select') || canvas && event.target === container.current) return;
    const mode = selectionMode(event);
    const base = mode === 'replace' ? [] : [...selectionRef.current];
    rubber.current = { pointer: event.pointerId, start: pointInSurface(event), mode, base, active: false, next: base, capture: event.currentTarget as HTMLElement };
    event.currentTarget.setPointerCapture(event.pointerId);
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    event.preventDefault();
  };
  const clearBoxPreview = () => {
    container.current?.querySelectorAll<HTMLElement>('[data-box-selected]').forEach(element => element.removeAttribute('data-box-selected'));
    selectionLayer.current?.removeAttribute('data-active');
    selectionRectangle.current?.setAttribute('width', '0'); selectionRectangle.current?.setAttribute('height', '0');
    setBox(null);
  };
  const backgroundUp = (event: ReactPointerEvent) => {
    if (drag.current) { void finishDrag(event); return; }
    const current = rubber.current;
    if (current?.pointer === event.pointerId) {
      rubber.current = null;
      if (current.capture.hasPointerCapture(event.pointerId)) current.capture.releasePointerCapture(event.pointerId);
      if (current.active) { commitSelection(current.next); props.onCloseSkill?.(); }
      else if (current.mode === 'replace') { commitSelection([]); props.onCloseSkill?.(); }
      clearBoxPreview();
    }
  };
  const cancelPointer = () => {
    const captured = drag.current || rubber.current; drag.current = null; rubber.current = null;
    if (captured?.capture.hasPointerCapture(captured.pointer)) captured.capture.releasePointerCapture(captured.pointer);
    setPreview({}); clearBoxPreview(); setDropTarget(null);
  };
  useEffect(() => { cancelPointer(); }, [location, view, query, options.sort, options.group]);
  useEffect(() => {
    if (!canvas) return;
    const visible = new Set(ordered.map(item => item.key));
    commitSelection(selectionRef.current.filter(key => visible.has(key)));
    if (anchor.current && !visible.has(anchor.current)) anchor.current = null;
  }, [canvas, ordered.map(item => item.key).join('|')]);
  useEffect(() => {
    const lost = (event: PointerEvent) => {
      const captured = drag.current || rubber.current;
      if (captured?.pointer === event.pointerId && captured.capture === event.target) cancelPointer();
    };
    const blur = () => { if (drag.current || rubber.current) cancelPointer(); };
    const visibility = () => { if (document.hidden) blur(); };
    document.addEventListener('lostpointercapture', lost, true);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('lostpointercapture', lost, true); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility);
      const captured = drag.current || rubber.current; drag.current = null; rubber.current = null;
      if (captured?.capture.hasPointerCapture(captured.pointer)) captured.capture.releasePointerCapture(captured.pointer);
    };
  }, []);
  const persistArrangement = async (mode: SortKey | 'position' | 'snap') => {
    if (filtering || busy || arrangementCommit.current) return false;
    arrangementCommit.current = true; setSavingOptions(true);
    try {
      const items = mode === 'position' || mode === 'snap' ? [...matched].sort((a, b) => {
        const first = snapshot.finderPositions?.[a.key]; const second = snapshot.finderPositions?.[b.key];
        if (!first) return second ? 1 : 0;
        if (!second) return -1;
        return first.y - second.y || first.x - second.x;
      }) : orderItems(matched, { ...options, sort: mode, direction: 'asc' });
      const occupied: Position[] = [];
      const updates = items.map((item, index) => {
        const preferred = mode === 'snap' ? snapshot.finderPositions?.[item.key] || defaultCanvasPosition(index) : gridPosition(index, width);
        const position = availablePosition(preferred, occupied); occupied.push(position);
        return { kind: item.kind, id: item.id, position };
      });
      return updates.length === 0 || await onCommit({ scopeId: scope, items: updates });
    } finally { arrangementCommit.current = false; setSavingOptions(false); }
  };
  const cleanUp = async () => { if (options.sort === 'manual' && options.group === 'manual') await persistArrangement('position'); };
  const changeSort = async (next: SortKey) => {
    if (next === options.sort || busy || arrangementCommit.current || filtering) return;
    if (next === 'manual' && options.sort !== 'manual' && !await persistArrangement(options.sort)) return;
    changeOptions({ sort: next });
  };
  const changeSnap = async (snap: boolean) => {
    if (snap === options.snap || busy || arrangementCommit.current || filtering) return;
    if (snap && !await persistArrangement('snap')) return;
    changeOptions({ snap });
  };
  const htmlDrop = (event: React.DragEvent, target: string | null) => {
    if (filtering || busy) return;
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    try { const payload = JSON.parse(event.dataTransfer.getData('application/x-skill-shelf')) as { scope: string; keys: string[] }; if (payload.scope === scope && Array.isArray(payload.keys)) void moveTo(payload.keys, target); } catch { /* Ignore foreign drops. */ }
  };
  const droppable = (target: string | null) => ({
    'data-finder-folder-id': target || '__root__',
    onDragOver: (event: React.DragEvent) => { if (!filtering && !busy && event.dataTransfer.types.includes('application/x-skill-shelf')) { event.preventDefault(); event.stopPropagation(); setDropTarget(target || '__root__'); } },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); },
    onDrop: (event: React.DragEvent) => htmlDrop(event, target),
  });

  const renderItem = (item: FinderItem, order: string[], column = false) => {
    const selected = selection.includes(item.key);
    const inPath = column && item.kind === 'folder' && chain.some(folder => folder.id === item.id);
    const point = preview[item.key] || positions[item.key] || { x: 28, y: 24 };
    const moving = Boolean(preview[item.key]);
    const managed = item.skill && 'packId' in item.skill ? item.skill : undefined;
    const check = props.updateChecks?.[item.id] || emptyCheck;
    const updateIndicator = !managed && item.skill ? <SkillUpdateIndicator check={check} /> : null;
    const installation = installationDetails(item.skill);
    const linkedLocations = managed?.deployments.filter(deployment => deployment.mode === 'symlink').length || 0;
    const linkDecoration = linkedLocations ? <FinderTooltip content={`已链接到 ${linkedLocations} 个位置`}><span className="finder-skill-link-indicator" aria-label={`已链接到 ${linkedLocations} 个位置`} role="img"><Link2 /></span></FinderTooltip> : null;
    const updating = props.updatingSkillIds?.includes(item.id) || false;
    const updateLabel = updating ? `正在更新 ${item.name}` : updateCheckFresh(check) ? `更新 ${item.name}` : `检查并更新 ${item.name}`;
    const updateDisabled = busy || updating || (updateCheckFresh(check) && check.status !== 'update-available');
    const savedAnnotation = item.kind === 'skill' ? props.annotations[item.id] : undefined;
    const annotation = savedAnnotation?.stale ? undefined : savedAnnotation;
    const description = annotation?.text || item.skill?.description || (item.skill ? '这个 Skill 暂时没有描述。' : '文件夹');
    const folderStyle = { '--folder-color': item.folder?.color || 'var(--ss-amber)' } as CSSProperties;
    const clickItem = (event: ReactMouseEvent) => {
      if ((event.target as HTMLElement).closest('input,.skill-row-quick-button')) return;
      const wasSuppressed = suppressedClick.current.has(item.key); selectItem(event, item, order);
      if (wasSuppressed) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) { props.onCloseSkill?.(); return; }
      if (column && item.kind === 'folder') onNavigate(item.id);
      else if (item.skill) onOpenSkill(item.skill);
      else props.onCloseSkill?.();
    };
    return <article key={item.key} data-testid={item.kind === 'skill' ? 'skill-card' : 'folder-item'} data-skill-name={item.name}
      data-finder-item-key={item.key} data-finder-item-kind={item.kind} aria-selected={selected} aria-current={inPath ? 'location' : undefined} role="option"
      className={`${canvas ? 'finder-canvas-item' : item.kind === 'folder' ? 'finder-list-folder-item' : 'skill-row'}${selected ? ' is-selected' : ''}${inPath ? ' is-path' : ''}`}
      data-dragging={moving ? drag.current?.anchorKey === item.key ? 'active' : 'group' : undefined} data-drop-target={item.id === dropTarget || undefined}
      style={canvas ? { transform: `translate3d(${point.x}px,${point.y}px,0)`, pointerEvents: moving ? 'none' : undefined } : undefined}
      draggable={column && !filtering && !busy}
      onDragStart={event => { if (canvas) { event.preventDefault(); event.stopPropagation(); return; } const keys = selected ? selection : [item.key]; commitSelection(keys); props.onCloseSkill?.(); event.dataTransfer.setData('application/x-skill-shelf', JSON.stringify({ scope, keys })); event.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => setDropTarget(null)}
      {...(item.kind === 'folder' ? droppable(item.id) : {})}
      onPointerDown={event => itemPointerDown(event, item)} onPointerMove={event => { if (canvas) event.stopPropagation(); pointerMove(event); }} onPointerUp={event => { if (drag.current) { event.stopPropagation(); void finishDrag(event); } }} onPointerCancel={cancelPointer}
      onClickCapture={canvas ? clickItem : undefined} onClick={canvas ? undefined : clickItem}
      onDoubleClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && item.kind === 'folder') onNavigate(item.id); }} onContextMenu={event => openContext(event, item)}>
      {canvas ? <div className={item.skill ? 'finder-skill-tile' : undefined}>
        <button className="finder-icon-button" aria-label={item.skill ? `查看 ${item.name} 详情` : item.name} style={folderStyle} data-drop-target={item.id === dropTarget || undefined} type="button">
          <span className={item.kind === 'folder' ? 'finder-folder-icon' : 'finder-skill-icon'}>{item.kind === 'folder' ? <FolderIcon /> : <><Boxes />{updateIndicator}{linkDecoration}{installation.kind === 'symlink' && <FinderTooltip content="软链接"><span className="finder-skill-link-indicator"><Link2 /></span></FinderTooltip>}</>}</span>
          <span title={item.name}>{item.name}</span>
        </button>
        {item.skill && <SkillInfoPreview item={item} annotation={savedAnnotation} staleTranslation={props.staleTranslationIds?.includes(item.id)} scopeLabel={title} check={managed ? undefined : check} className="finder-skill-info" />}
      </div> : item.kind === 'folder' ? <button className={`finder-list-folder${selected ? ' is-selected' : ''}${inPath ? ' is-path' : ''}`} aria-label={item.name} style={folderStyle} data-drop-target={item.id === dropTarget || undefined} type="button">
        <FolderIcon style={{ color: item.folder?.color || 'var(--ss-amber)' }} /><strong>{item.name}</strong><span>文件夹</span><ChevronRight />
      </button> : <>
        <button className="skill-row-open" aria-label={`查看 ${item.name} 详情`} type="button">
          <span className="skill-row-copy">
            <span className="skill-row-title">{updateIndicator}{linkDecoration}<strong>{item.name}</strong>{installation.kind === 'symlink' && <FinderTooltip content="软链接"><span className="skill-title-link-indicator" title={installation.linkTarget}><Link2 /></span></FinderTooltip>}{item.parentId && <span className="group-badge">{folders.find(folder => folder.id === item.parentId)?.name}</span>}</span>
            <span className="skill-row-description">{description}</span>
            <span className="skill-row-meta"><span className="skill-scope-label">{title}</span><span className="skill-source-label">{skillSource(item)}</span><span className="skill-install-kind-label" data-kind={installation.kind} title={installation.linkTarget}><installation.Icon />{installation.label}</span>{item.tags.slice(0, 3).map(tag => <span className="skill-tag-label" key={tag}>#{tag}</span>)}</span>
          </span>
          <ChevronRight className="skill-row-chevron" />
        </button>
        <div className="skill-row-quick-actions">
          <SkillInfoPreview item={item} annotation={savedAnnotation} staleTranslation={props.staleTranslationIds?.includes(item.id)} scopeLabel={title} check={managed ? undefined : check} />
          <FinderTooltip content="打开文件夹"><button className="skill-row-quick-button" aria-label={`打开 ${item.name} 文件夹`} onClick={event => { event.stopPropagation(); props.onOpenFolder(item.id); }} onPointerDown={event => event.stopPropagation()} type="button"><FolderOpen /></button></FinderTooltip>
          {!managed && props.onUpdate && <FinderTooltip content={updateLabel}><button className="skill-row-quick-button" aria-label={updateLabel} aria-busy={updating} disabled={updateDisabled} onClick={event => { event.stopPropagation(); props.onUpdate?.([item.id]); }} onPointerDown={event => event.stopPropagation()} type="button">{updating ? <LoaderCircle className="finder-update-spin" /> : <RefreshCw />}</button></FinderTooltip>}
        </div>
      </>}
    </article>;
  };

  const columnLocations = filtering ? [folderId] : [null, ...chain.map(folder => folder.id)];
  const columnOptions = { ...options, sort: options.sort === 'manual' ? 'name' as const : options.sort };
  const renderedOrder = view === 'columns' && !filtering ? columnLocations.flatMap(id => [...finderGroups(orderItems(allItems.filter(item => item.parentId === id), columnOptions), activeGroup).values()].flat().map(item => item.key)) : [...groups.values()].flat().map(item => item.key);
  const surfaceHeight = Math.max(620, ...Object.values(positions).map(point => point.y + 150));
  const surfaceWidth = options.group === 'manual' ? Math.max(980, ...Object.values(positions).map(point => point.x + 150)) : '100%';
  const menuBusy = busy || savingOptions;
  const contextCheck = context?.item ? props.updateChecks?.[context.item.id] || emptyCheck : emptyCheck;
  const contextUpdating = Boolean(context?.item && props.updatingSkillIds?.includes(context.item.id));
  const contextUpdateDisabled = menuBusy || contextUpdating || (updateCheckFresh(contextCheck) && contextCheck.status !== 'update-available');
  const canCleanUp = !menuBusy && !filtering && matched.length >= 2 && options.group === 'manual' && options.sort === 'manual';
  const canSnap = !menuBusy && !filtering && options.group === 'manual' && options.sort === 'manual';
  const arrangementControls = <div className="finder-arrangement-tools">
    <DropdownMenu.Root modal={false} open={arrangement === 'group'} onOpenChange={open => { setContext(null); setArrangement(open ? 'group' : null); }}>
      <DropdownMenu.Trigger asChild><button className="finder-sort-trigger" aria-label="群组方式" disabled={filtering || menuBusy} type="button"><Boxes /><span>群组方式</span><span className="finder-sort-current">{options.group === 'manual' ? '无' : sortLabels[options.group]}</span><ChevronDown /></button></DropdownMenu.Trigger>
      <DropdownMenu.Content aria-label="Finder 群组方式"><DropdownMenu.Label>群组方式</DropdownMenu.Label><DropdownMenu.RadioGroup value={options.group} onValueChange={group => changeOptions({ group: group as SortKey })}>
        <DropdownMenu.RadioItem value="manual">无</DropdownMenu.RadioItem><DropdownMenu.Separator />
        {contextSortChoices.map(([value, label]) => <DropdownMenu.RadioItem key={value} value={value} disabled={menuBusy}>{label}</DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup></DropdownMenu.Content>
    </DropdownMenu.Root>
    <DropdownMenu.Root modal={false} open={arrangement === 'sort'} onOpenChange={open => { setContext(null); setArrangement(open ? 'sort' : null); }}>
      <DropdownMenu.Trigger asChild><button className="finder-sort-trigger" aria-label="排序" disabled={filtering || menuBusy} type="button"><ArrowUpDown /><span>排序</span><span className="finder-sort-current">{options.sort === 'manual' ? '无' : sortLabels[options.sort]}</span><ChevronDown /></button></DropdownMenu.Trigger>
      <DropdownMenu.Content aria-label="Finder 排序"><DropdownMenu.Label>排序方式</DropdownMenu.Label><DropdownMenu.RadioGroup value={options.sort} onValueChange={sort => { void changeSort(sort as SortKey); }}>
        {iconView && <DropdownMenu.RadioItem value="manual">无</DropdownMenu.RadioItem>}
        {contextSortChoices.map(([value, label]) => <DropdownMenu.RadioItem key={value} value={value} disabled={menuBusy}>{label}</DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>{options.sort !== 'manual' && <><DropdownMenu.Separator /><DropdownMenu.RadioGroup value={options.direction} onValueChange={direction => changeOptions({ direction: direction as FinderOptions['direction'] })}>
        <DropdownMenu.RadioItem value="desc"><ChevronDown />降序</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="asc"><ChevronUp />升序</DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup></>}{iconView && <><DropdownMenu.Separator /><DropdownMenu.Item disabled={!canCleanUp} onSelect={() => { void cleanUp(); }}><Grid2X2 />整理</DropdownMenu.Item>
        <DropdownMenu.Sub><DropdownMenu.SubTrigger className="shelf-menu-item shelf-menu-sub-trigger" disabled={!canCleanUp}><ArrowDown />整理方式<ChevronRight className="shelf-menu-chevron" /></DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className="shelf-menu" sideOffset={4} collisionPadding={8}>
          {contextSortChoices.map(([value, label]) => <DropdownMenu.Item key={value} onSelect={() => { void persistArrangement(value); }}>{label}</DropdownMenu.Item>)}
        </DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub></>}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>;

  return <div className="finder-workbench" data-testid="finder-workspace" data-view={filtering ? 'search' : view}>
    {arrangementTarget && createPortal(arrangementControls, arrangementTarget)}
    <div ref={container} className={`finder-browser${canvas ? ' finder-canvas-scroll' : ' finder-list-view'}`} data-view={view === 'columns' ? 'columns' : 'list'}
      role="listbox" aria-label={`${title} Finder 文件浏览器`} aria-multiselectable="true" tabIndex={0}
      onContextMenu={event => openContext(event)} onPointerDown={backgroundDown} onPointerMove={pointerMove} onPointerUp={backgroundUp} onPointerCancel={cancelPointer}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest('input,select,.skill-row-quick-button')) return;
        if (event.key === 'Escape') { onSelection([]); props.onCloseSkill?.(); setContext(null); }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); commitSelection([...new Set(renderedOrder)]); anchor.current = renderedOrder.at(-1) || null; props.onCloseSkill?.(); }
        if ((event.key === 'Enter' || event.key === ' ') && selection.length === 1) { event.preventDefault(); const item = allItems.find(item => item.key === selection[0]); if (item?.folder && event.key === 'Enter') onNavigate(item.id); else if (item?.skill) onOpenSkill(item.skill); }
        if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
          event.preventDefault(); const last = anchor.current || selection[selection.length - 1]; const index = renderedOrder.indexOf(last); const distance = canvas && (event.key === 'ArrowDown' || event.key === 'ArrowUp') ? Math.max(1, Math.floor((width - 40) / 124)) : 1; const step = (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) * distance;
          const next = renderedOrder[Math.max(0, Math.min(renderedOrder.length - 1, index < 0 ? 0 : index + step))]; if (next) { onSelection(event.shiftKey ? applySelection(selection, selectRange(renderedOrder, anchor.current, next), 'add') : [next]); if (!event.shiftKey) anchor.current = next; container.current?.querySelector<HTMLElement>(`[data-finder-item-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        }
      }}>
      {canvas ? <div ref={surface} className="finder-canvas finder-canvas-surface" style={{ height: surfaceHeight, minWidth: surfaceWidth }} data-grouped={options.group !== 'manual'} data-testid="finder-canvas-surface">
        {headings.map(heading => <div className="finder-group-heading" key={heading.label} style={{ top: heading.y, left: 28 }}><strong>{heading.label}</strong><span>{heading.count}</span></div>)}
        {ordered.map(item => renderItem(item, renderedOrder))}
        <svg ref={selectionLayer} className="finder-selection-layer" aria-hidden="true"><rect ref={selectionRectangle} className="finder-selection-rect" width="0" height="0" /></svg>
      </div> : view === 'columns' ? columnLocations.map((id, index) => {
        const items = filtering ? ordered : orderItems(allItems.filter(item => item.parentId === id), columnOptions);
        return <section className="finder-column-panel" key={id || 'root'} data-testid="finder-column" data-current={index === columnLocations.length - 1} data-drop-target={dropTarget === (id || '__root__') || undefined} {...droppable(id)}><header><FolderIcon /><span>{filtering ? '搜索结果' : id ? folders.find(folder => folder.id === id)?.name : title}</span><small>{items.length}</small></header><div>{[...finderGroups(items, activeGroup)].map(([label, members]) => <section className="finder-list-group" key={label}>{label && <div className="finder-list-group-heading"><strong>{label}</strong><span>{members.length}</span></div>}{members.map(item => renderItem(item, [...finderGroups(items, activeGroup).values()].flat().map(member => member.key), true))}</section>)}{items.length === 0 && <p className="finder-folder-empty">{filtering ? '没有匹配项目' : '空文件夹'}{!filtering && <small>可将项目拖入这一栏</small>}</p>}</div></section>;
      }) : <>{view === 'list' && <div className="finder-list-header"><button aria-pressed={options.sort === 'name'} onClick={() => changeOptions({ sort: 'name', direction: options.sort === 'name' && options.direction === 'asc' ? 'desc' : 'asc' })}>名称</button><span>描述</span><button aria-pressed={options.sort === 'source'} onClick={() => changeOptions({ sort: 'source', direction: options.sort === 'source' && options.direction === 'asc' ? 'desc' : 'asc' })}>来源 / 标签</button></div>}{Array.from(groups).map(([label, items]) => <section className="finder-list-group" key={label}>{label && <div className="finder-list-group-heading"><strong>{label}</strong><span>{items.length}</span></div>}{items.map(item => renderItem(item, renderedOrder))}</section>)}{box && <div className="finder-selection-rectangle" style={{ left: box.x, top: box.y - (container.current?.scrollTop || 0), width: box.width, height: box.height }} />}</>}
      {matched.length === 0 && view !== 'columns' && <div className="finder-folder-empty">{filtering ? '没有匹配项目' : '这个文件夹还是空的'}{!filtering && <small>双击文件夹进入 · 拖动空白处框选 · ⌘ / Ctrl 多选</small>}</div>}
    </div>
    {context && <PositionedMenu key={`${context.x}:${context.y}:${context.item?.key || 'background'}`} position={context} label="Finder 快捷操作" onClose={() => setContext(null)}>
      {context.item ? <>
        <ContextMenu.Label>{context.keys.length > 1 ? `已选择 ${context.keys.length} 项` : context.item.name}</ContextMenu.Label>
        {context.item.folder && context.keys.length === 1 && <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onEditFolder(context.item!.folder!)}><PencilLine />重命名文件夹</ContextMenu.Item>}
        {context.item.skill && context.keys.length === 1 && <>
          <ContextMenu.Item onSelect={() => onOpenSkill(context.item!.skill!)}><Info />查看详情</ContextMenu.Item>
          {!scope.startsWith('pack:') || !canvas ? <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onOpenFolder(context.item!.id)}><FolderOpen />打开文件夹</ContextMenu.Item> : null}
          {!canvas && <ContextMenu.Sub><ContextMenu.SubTrigger disabled={menuBusy}><FolderInput />移动到文件夹</ContextMenu.SubTrigger><ContextMenu.SubContent aria-label="移动到文件夹">
            <ContextMenu.CheckboxItem checked={context.item.parentId === null} icon={<FolderOpen />} onSelect={() => { void moveTo([context.item!.key], null); }}>未整理</ContextMenu.CheckboxItem>
            {folders.map(folder => <ContextMenu.CheckboxItem key={folder.id} checked={context.item!.parentId === folder.id} icon={<FolderIcon />} onSelect={() => { void moveTo([context.item!.key], folder.id); }}>{folder.name}</ContextMenu.CheckboxItem>)}
            {folders.length === 0 && <ContextMenu.Label>创建第一个文件夹</ContextMenu.Label>}
          </ContextMenu.SubContent></ContextMenu.Sub>}
        </>}
        {scope.startsWith('pack:') ? <>
          {context.item.folder && <ContextMenu.Item className="skill-context-menu-destructive" disabled={menuBusy} onSelect={() => props.onDeleteFolder(context.item!.folder!)}><Trash2 />删除文件夹</ContextMenu.Item>}
          {context.item.skill && context.keys.length === 1 && <>
            <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onOrganizeSkill(context.item!.skill as ManagedSkill)}><PencilLine />整理 {context.item.name}</ContextMenu.Item>
            <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onDeploy([context.item!.id])}><Rocket />添加 Skill</ContextMenu.Item>
            {canvas && <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onOpenFolder(context.item!.id)}><FolderOpen />打开文件夹</ContextMenu.Item>}
            <ContextMenu.Separator />
            <ContextMenu.Item className="skill-context-menu-destructive" disabled={menuBusy} onSelect={() => props.onDeleteSkill(context.item!.skill as ManagedSkill)}><Trash2 />删除</ContextMenu.Item>
          </>}
        </> : <>
          <ContextMenu.Item disabled={menuBusy || !aiPreferences.enabled || selectedSkillIds(context.keys, allItems, folders).length === 0} onSelect={() => props.onTranslate(selectedSkillIds(context.keys, allItems, folders))}><Languages />{context.keys.length > 1 ? '翻译所选项目的 description' : context.item.folder ? '翻译此文件夹中的 description' : '翻译 description'}</ContextMenu.Item>
          <ContextMenu.Item disabled={menuBusy || selectedSkillIds(context.keys, allItems, folders).length === 0} onSelect={() => props.onImport(selectedSkillIds(context.keys, allItems, folders))}><PackagePlus />{context.keys.length > 1 ? '将所选 Skill 导入 Packs' : context.item.folder ? '将文件夹中的 Skill 导入 Packs' : '导入到 Packs'}</ContextMenu.Item>
          {context.item.skill && context.keys.length === 1 && props.onUpdate && <><ContextMenu.Separator /><ContextMenu.Item disabled={contextUpdateDisabled} onSelect={() => props.onUpdate?.([context.item!.id])}>{contextUpdating ? <LoaderCircle className="finder-update-spin" /> : <RefreshCw />}{contextUpdating ? '正在更新…' : '更新'}</ContextMenu.Item></>}
        </>}
      </> : <>
        <ContextMenu.Label>当前位置</ContextMenu.Label>
        <ContextMenu.Item disabled={menuBusy} onSelect={() => props.onCreateFolder(context.point)}><FolderPlus />新建文件夹</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Sub><ContextMenu.SubTrigger><Grid2X2 />显示</ContextMenu.SubTrigger><ContextMenu.SubContent aria-label="显示">
          <ContextMenu.RadioGroup value={view} onValueChange={next => props.onView(next as ViewMode)}>
            {([['grid', Grid2X2, '图标视图'], ['list', List, '列表视图'], ['columns', Columns3, '分栏视图']] as const).map(([mode, Icon, label]) => <ContextMenu.RadioItem key={mode} value={mode}><Icon />{label}</ContextMenu.RadioItem>)}
          </ContextMenu.RadioGroup>{canvas && <><ContextMenu.Separator />
          <ContextMenu.CheckboxItem checked={options.snap} disabled={!canSnap} icon={<Grid2X2 />} onSelect={() => { void changeSnap(!options.snap); }}>对齐到网格</ContextMenu.CheckboxItem></>}
        </ContextMenu.SubContent></ContextMenu.Sub>
        <ContextMenu.CheckboxItem checked={options.group !== 'manual'} disabled={menuBusy} icon={<Boxes />} onSelect={() => changeOptions({ group: options.group === 'manual' ? options.groupBy || 'kind' : 'manual' })}>使用群组</ContextMenu.CheckboxItem>
        <ContextMenu.Sub><ContextMenu.SubTrigger disabled={menuBusy}><Boxes />群组方式</ContextMenu.SubTrigger><ContextMenu.SubContent aria-label="群组方式">
          <ContextMenu.RadioGroup value={options.group} onValueChange={group => changeOptions({ group: group as SortKey })}>
            <ContextMenu.RadioItem value="manual">无</ContextMenu.RadioItem><ContextMenu.Separator />
            {contextSortChoices.map(([value, label]) => <ContextMenu.RadioItem key={value} value={value}>{label}</ContextMenu.RadioItem>)}
          </ContextMenu.RadioGroup>
        </ContextMenu.SubContent></ContextMenu.Sub>
        <ContextMenu.Sub><ContextMenu.SubTrigger disabled={menuBusy}><ArrowUpDown />排序方式</ContextMenu.SubTrigger><ContextMenu.SubContent aria-label="排序方式">
          <ContextMenu.RadioGroup value={!canvas && options.sort === 'manual' ? 'name' : options.sort} onValueChange={sort => { void changeSort(sort as SortKey); }}>
            {canvas && <><ContextMenu.RadioItem value="manual">无</ContextMenu.RadioItem><ContextMenu.Separator /></>}
            {contextSortChoices.map(([value, label]) => <ContextMenu.RadioItem key={value} value={value}>{label}</ContextMenu.RadioItem>)}
          </ContextMenu.RadioGroup>
          {(!canvas || options.sort !== 'manual') && <><ContextMenu.Separator /><ContextMenu.RadioGroup value={options.direction} onValueChange={direction => changeOptions({ direction: direction as FinderOptions['direction'] })}>
            <ContextMenu.RadioItem value="desc"><ChevronDown />降序</ContextMenu.RadioItem><ContextMenu.RadioItem value="asc"><ChevronUp />升序</ContextMenu.RadioItem>
          </ContextMenu.RadioGroup></>}
        </ContextMenu.SubContent></ContextMenu.Sub>
        {canvas && <><ContextMenu.Item disabled={!canCleanUp} onSelect={() => { void cleanUp(); }}><Grid2X2 />整理</ContextMenu.Item>
        <ContextMenu.Sub><ContextMenu.SubTrigger disabled={!canCleanUp}><ArrowDown />整理方式</ContextMenu.SubTrigger><ContextMenu.SubContent aria-label="整理方式">
          {contextSortChoices.map(([value, label]) => <ContextMenu.Item key={value} onSelect={() => { void persistArrangement(value); }}>{label}</ContextMenu.Item>)}
        </ContextMenu.SubContent></ContextMenu.Sub></>}
      </>}
    </PositionedMenu>}
  </div>;
}

function SkillUpdateIndicator({ check }: { check: UpdateCheck }) {
  const Glyph = updateGlyphs[check.status as keyof typeof updateGlyphs] || CircleDashed;
  const statusLabel = updateLabels[check.status] || updateLabels.unchecked;
  const stale = check.status !== 'unchecked' && !updateCheckFresh(check);
  const checkedAt = Date.parse(check.checkedAt || '');
  return <FinderTooltip className="skill-update-tooltip" content={<>
    <strong>{statusLabel}</strong><span>{updateReasons[check.reason] || '运行更新扫描后会与上游来源比较。'}</span>
    {stale && <small data-state="stale">这是上次扫描结果；更新前需要重新检查。</small>}
    {Number.isFinite(checkedAt) && <small>检查于 {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(checkedAt))}</small>}
  </>}><span role="img" className="skill-update-indicator" data-status={check.status} data-stale={stale ? 'true' : undefined} aria-label={statusLabel}><Glyph /></span></FinderTooltip>;
}

function SkillInfoPreview({ item, annotation, staleTranslation, scopeLabel, check, className = '' }: { item: FinderItem; annotation?: AiAnnotation; staleTranslation?: boolean; scopeLabel: string; check?: UpdateCheck; className?: string }) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = (timer: typeof openTimer) => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const clearTimers = () => { clearTimer(openTimer); clearTimer(closeTimer); };
  const closeNow = () => { clearTimers(); setOpen(false); };
  const scheduleOpen = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearTimers();
    openTimer.current = setTimeout(() => { openTimer.current = null; setOpen(true); }, 320);
  };
  const scheduleClose = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearTimers();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, 140);
  };
  useEffect(() => () => clearTimers(), []);
  useEffect(() => {
    if (!open) return;
    const closeForWheel = (event: WheelEvent) => {
      if (!event.composedPath().some(target => target instanceof HTMLElement && target.dataset.mouseHoverCardContent === 'true')) closeNow();
    };
    window.addEventListener('blur', closeNow);
    window.addEventListener('wheel', closeForWheel, { capture: true });
    return () => { window.removeEventListener('blur', closeNow); window.removeEventListener('wheel', closeForWheel, { capture: true }); };
  }, [open]);
  const resolvedAnnotation = annotation?.stale ? undefined : annotation;
  const DescriptionIcon = resolvedAnnotation ? resolvedAnnotation.kind === 'translation' ? Languages : Sparkles : Braces;
  const installation = installationDetails(item.skill);
  const StatusIcon = updateGlyphs[check?.status as keyof typeof updateGlyphs] || CircleDashed;
  return <HoverCard.Root open={open}>
    <HoverCard.Trigger asChild onPointerDown={closeNow} onPointerEnter={scheduleOpen} onPointerLeave={scheduleClose}>
      <button className={`skill-row-quick-button skill-info-trigger ${className}`} aria-label={`预览 ${item.name} 的信息`}
        onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onPointerDown={event => { event.stopPropagation(); closeNow(); }} type="button"><Info /></button>
    </HoverCard.Trigger>
    <HoverCard.Portal><HoverCard.Content className="skill-hover-card" role="tooltip" aria-label={`${item.name} 信息预览`} align="end" side="top" sideOffset={8} collisionPadding={12}
      data-mouse-hover-card-content="true" onEscapeKeyDown={closeNow} onPointerDownOutside={closeNow} onPointerEnter={scheduleOpen} onPointerLeave={scheduleClose}>
      <div className="skill-hover-card-heading"><span aria-hidden="true"><Boxes /></span><div><strong>{item.name}</strong><small title={skillSource(item) || item.skill?.path}>{skillSource(item)}</small></div></div>
      <div className="skill-hover-card-description"><div className="skill-hover-card-description-source">
        <span data-source={resolvedAnnotation ? resolvedAnnotation.kind === 'translation' ? 'ai-translation' : 'ai-description' : 'original'}><DescriptionIcon />{resolvedAnnotation ? resolvedAnnotation.kind === 'translation' ? 'AI 翻译 · 仅存本机' : 'AI 生成描述 · 仅存本机' : 'Skill 原始 description'}</span>
        {(staleTranslation || (annotation?.stale && annotation.kind === 'translation')) && <span data-state="stale"><CircleAlert />已保存的翻译已过期</span>}
      </div><p>{resolvedAnnotation?.text || item.skill?.description || '这个 Skill 暂时没有描述。'}</p></div>
      <div className="skill-hover-card-facts">
        {check && <span data-status={check.status}><StatusIcon />{updateLabels[check.status] || updateLabels.unchecked}</span>}
        <span><HardDrive />{scopeLabel}</span><span title={installation.linkTarget}><installation.Icon />{installation.label}</span>
      </div>
      {item.tags.length > 0 && <div className="skill-hover-card-tags">{item.tags.slice(0, 4).map(tag => <span key={tag}>#{tag}</span>)}{item.tags.length > 4 && <span>+{item.tags.length - 4}</span>}</div>}
    </HoverCard.Content></HoverCard.Portal>
  </HoverCard.Root>;
}
