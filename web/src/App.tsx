import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Boxes, Check, ChevronDown, ChevronRight,
  Bot, Columns3, Compass, Copy, FileText, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, Grid2X2, HardDrive,
  Globe2, Gauge, Layers3, Library, Link2, List, Loader2, Menu, MoreHorizontal, Package, PanelLeft, PanelLeftClose, Plus, RefreshCw,
  PackagePlus, PencilLine, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Tag, Trash2, Upload, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { exportPack, mutate, request } from './api';
import { toast } from './ShelfToast';
import ShelfDialog, { DialogTitle } from './ShelfDialog';
import ShelfTooltip from './ShelfTooltip';
import FinderWorkspace from './FinderWorkspace';
import AiAssistantSidebar from './AiAssistantSidebar';
import SkillInspector from './SkillInspector';
import { useSkillsOperations } from './SkillsOperations';
import './ai-assistant-sidebar.css';
import ShelfSelect from './ShelfSelect';
import { Input, Textarea } from './ShelfForm';
import Workbench from './Workbench';
import ShelfButton from './ShelfButton';
import { t } from './desktop-ui';
import DiscoverWorkspace from './DiscoverWorkspace';
import SkillRemovalButton from './SkillRemovalButton';
import { ProjectInstructionsButton } from './ProjectInstructions';
import { SyncPreviewDialog, type Preview as SyncPreview } from './SyncSettings';
import SettingsWorkspace, { type SettingsSection } from './SettingsWorkspace';
import { initialPage, readUiPreferences, rememberPage, saveUiPreferences, type UiPreferences } from './ui-preferences';
import { useAiPreferences } from './ai-preferences';
import { translateDescriptions } from './translate-descriptions';
import { getSkillTranslation, isLikelyIncompleteTranslation, selectSkillAnnotation } from './resolve-skill-description';
import { defaultCanvasPosition, defaultFinderOptions, finderItems, movableItems, type FinderOptions } from './finder-state';
import { fromPortableView, toPortableView, portableFolderKey } from './portable-view-options';
import type { AiAnnotation, Folder, ManagedSkill, Pack, Position, Skill, Snapshot, Theme, ViewMode, PortablePreferences } from './types';

type DialogState =
  | { kind: 'pack'; pack?: Pack }
  | { kind: 'folder'; folder?: Folder; position?: Position }
  | { kind: 'pack-organize'; skill: ManagedSkill }
  | { kind: 'import'; packId?: string; ids?: string[] }
  | { kind: 'deploy'; ids: string[] }
  | { kind: 'root' }
  | { kind: 'project' }
  | { kind: 'confirm'; title: string; description: string; run: () => Promise<Snapshot> };

function stored<T>(key: string, fallback: T): T {
  try { return (JSON.parse(localStorage.getItem(key) || 'null') as T | null) ?? fallback; } catch { return fallback; }
}
const pathId = encodeURIComponent;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const markdownBody = (text: string) => text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
const organization = (state: Snapshot, id: string) => state.organization[id] || { folderId: null, tags: [] };
type FinderPreferences = FinderOptions & { view: ViewMode };

function normalizeFinderPreferences(saved: Partial<FinderPreferences>, defaultView: ViewMode): FinderPreferences {
  const preferences = { ...defaultFinderOptions, view: defaultView, ...saved };
  return { ...preferences, groupBy: saved.groupBy && saved.groupBy !== 'manual' ? saved.groupBy : preferences.group !== 'manual' ? preferences.group : 'kind' };
}
function finderPreferences(location: string, defaultView: ViewMode): FinderPreferences {
  return normalizeFinderPreferences(stored<Partial<FinderOptions>>(`shelf-finder:${location}`, {}), defaultView);
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <ShelfTooltip content={label}><ShelfButton variant="ghost" size="icon-sm" aria-label={label} className="icon-button" {...props}>{children}</ShelfButton></ShelfTooltip>;
}

// Keep the original Skill Shelf mark and wordmark rather than a plugin-specific logo.
function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="ss-brand"><svg aria-hidden="true" className="ss-brand__mark" focusable="false" viewBox="0 0 220 220"><rect fill="var(--ss-ink-strong)" height="220" rx="64" width="220" /><path d="M66 90H74Q82 90 82 98V167Q82 170 79 170H61Q58 170 58 167V98Q58 90 66 90Z" fill="var(--ss-card)" /><path d="M106 65H114Q122 65 122 73V167Q122 170 119 170H101Q98 170 98 167V73Q98 65 106 65Z" fill="var(--primary)" /><path d="M146 102H154Q162 102 162 110V167Q162 170 159 170H141Q138 170 138 167V110Q138 102 146 102Z" fill="var(--ss-card)" /></svg>{!compact && <span className="ss-brand__wordmark"><strong>Skill</strong> Shelf</span>}</span>;
}

function Modal({ title, children, onClose, busy = false, drawer = false, className = '' }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean; className?: string;
}) {
  return <ShelfDialog onClose={onClose} locked={busy} aria-describedby={undefined} className={`${drawer ? 'detail-drawer' : 'modal'} ${className}`}>
    <div className="modal-heading"><DialogTitle asChild><h2>{title}</h2></DialogTitle></div>
    {children}
  </ShelfDialog>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export default function App() {
  const [initialRoute] = useState(initialPage);
  const [uiPreferences, setUiPreferences] = useState(readUiPreferences);
  const aiPreferences = useAiPreferences();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [previousScreen, setPreviousScreen] = useState<'shelf' | 'workbench' | 'discover'>(initialRoute.screen);
  const [state, setState] = useState<Snapshot | null>(null);
  const [annotations, setAnnotations] = useState<AiAnnotation[]>([]);
  const [error, setErrorState] = useState('');
  const setError = (text: string) => {
    setErrorState(text);
    if (text && state) toast.error(text);
  };
  const [busy, setBusy] = useState(false);
  const [accessApplying, setAccessApplying] = useState(false);
  const [packPreview, setPackPreview] = useState<SyncPreview | null>(null);
  const [packResolutions, setPackResolutions] = useState<Record<string, 'local' | 'incoming'>>({});
  const packImportFocus = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState(initialRoute.scope);
  const [folderId, setFolderId] = useState<string | null>(initialRoute.folderId);
  const [screen, setScreen] = useState<'shelf' | 'settings' | 'workbench' | 'discover'>(() => window.location.hash === '#settings' ? 'settings' : initialRoute.screen);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [defaultView] = useState<ViewMode>(() => stored('shelf-view', 'grid'));
  const [finderLocations, setFinderLocations] = useState<Record<string, FinderPreferences>>(() => Object.fromEntries(Object.entries(stored<Record<string, FinderPreferences>>('shelf-finder-locations', {})).map(([location, saved]) => [location, normalizeFinderPreferences(saved, defaultView)])));
  const finderLocation = `${scope}:${folderId || 'root'}`;
  const preferences = useMemo(() => {
    const pack = state?.packs.find(item => scope === `pack:${item.id}`);
    const folder = state?.folders.find(item => item.id === folderId);
    const portable = folder?.viewOptions ?? pack?.viewOptions?.[portableFolderKey(state?.folders ?? [], folderId)] ?? (!folderId ? state?.rootViewOptions?.[scope] : undefined);
    if (portable) return fromPortableView(portable);
    const local = finderLocations[finderLocation] || finderPreferences(finderLocation, defaultView);
    if (scope === 'global' && !folderId && state?.portablePreferences?.libraryViewMode) return { ...local, view: state.portablePreferences.libraryViewMode === 'canvas' ? 'grid' as const : state.portablePreferences.libraryViewMode };
    if (pack?.sort && !finderLocations[finderLocation]) return { ...local, sort: pack.sort === 'manual' ? 'manual' as const : 'name' as const, direction: pack.sort === 'name-asc' ? 'asc' as const : 'desc' as const };
    return local;
  }, [finderLocations, finderLocation, defaultView, state, scope, folderId]);
  const view = preferences.view;
  const saveFinderPreferences = (next: FinderPreferences) => {
    setFinderLocations(current => ({ ...current, [finderLocation]: next }));
    void request<Snapshot>('/view-options', 'PATCH', { scopeId: scope, folderId, viewOptions: toPortableView(next) }).then(setState).catch(error => setError(message(error)));
  };
  const setView = (next: ViewMode) => {
    saveFinderPreferences({ ...preferences, view: next, sort: next !== 'grid' && preferences.sort === 'manual' ? 'name' : preferences.sort });
    if (scope === 'global' && !folderId) savePortablePreferences({ libraryViewMode: next === 'grid' ? 'canvas' : next });
  };
  const setFinderOptions = (options: FinderOptions) => saveFinderPreferences({ ...options, view });
  const [theme, setTheme] = useState<Theme>(() => stored('shelf-theme', 'system'));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const setSelected = (ids: string[]) => setSelectedKeys(ids.map(id => `skill:${id}`));
  const [history, setHistory] = useState<{ scope: string; entries: (string | null)[]; index: number }>({ scope: initialRoute.scope, entries: [initialRoute.folderId], index: 0 });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<Skill | ManagedSkill | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSkill, setAssistantSkill] = useState<Skill | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => stored('shelf-sidebar-collapsed', false));
  const [scopeCollapsed, setScopeCollapsed] = useState(() => stored('shelf-scope-collapsed', false));
  const [scopeWidth, setScopeWidth] = useState(() => stored('shelf-scope-width', 200));
  const scopePanelRef = useRef<HTMLDivElement>(null);
  const scopeResizeCleanup = useRef<(() => void) | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const translatingRef = useRef(false);

  useEffect(() => { void request<Snapshot>('/state').then(setState).catch(error => setError(message(error))); }, []);
  useEffect(() => {
    const navigateSettingsLink = () => {
      if (accessApplying) return;
      if (window.location.hash === '#settings') {
        if (screen !== 'settings') setPreviousScreen(screen);
        setScreen('settings'); setSettingsSection('general'); setDetail(null); setSelectedKeys([]); setSidebarOpen(false);
      } else if (screen === 'settings') {
        const route = initialPage();
        setScreen(route.screen); setScope(route.scope); setFolderId(route.folderId);
        setHistory({ scope: route.scope, entries: [route.folderId], index: 0 });
      }
    };
    window.addEventListener('hashchange', navigateSettingsLink);
    return () => window.removeEventListener('hashchange', navigateSettingsLink);
  }, [screen, accessApplying]);
  useEffect(() => {
    if (!state) return;
    if (scope !== 'global' && !state.packs.some(pack => scope === `pack:${pack.id}`) && !state.projects.some(project => scope === `project:${project.id}`)) {
      setScope(scope.startsWith('pack:') ? 'pack:default' : 'global'); setFolderId(null);
    } else if (folderId && !state.folders.some(folder => folder.id === folderId && folder.scopeId === scope)) setFolderId(null);
  }, [state, scope, folderId]);
  useEffect(() => { if (state && screen !== 'settings') rememberPage(screen, scope, folderId); }, [state, screen, scope, folderId]);
  useEffect(() => { document.documentElement.dataset.density = uiPreferences.density; }, [uiPreferences.density]);
  const savePortablePreferences = (patch: PortablePreferences) => {
    void request<Snapshot>('/preferences', 'PATCH', patch).then(setState).catch(error => setError(message(error)));
  };
  const portableInitialized = useRef(false);
  useEffect(() => {
    if (!state) return;
    const portable = state.portablePreferences ?? {};
    if (!portableInitialized.current) {
      portableInitialized.current = true;
      if (!Object.keys(portable).length) savePortablePreferences({ theme, density: uiPreferences.density, focusedAgents: uiPreferences.focusedAgents, sidebarCollapsed, libraryViewMode: defaultView === 'grid' ? 'canvas' : defaultView });
    }
    if (portable.theme) setTheme(portable.theme);
    if (portable.sidebarCollapsed !== undefined) setSidebarCollapsed(portable.sidebarCollapsed);
    if (portable.density || portable.focusedAgents) {
      setUiPreferences(current => {
        const next = { ...current, ...(portable.density ? { density: portable.density } : {}), ...(portable.focusedAgents ? { focusedAgents: portable.focusedAgents } : {}) };
        saveUiPreferences(next); return next;
      });
    }
    if (portable.libraryViewMode) localStorage.setItem('shelf-view', JSON.stringify(portable.libraryViewMode === 'canvas' ? 'grid' : portable.libraryViewMode));
  }, [JSON.stringify(state?.portablePreferences)]);
  const updateUiPreferences = (next: UiPreferences) => {
    try { saveUiPreferences(next); setUiPreferences(next); savePortablePreferences({ density: next.density, focusedAgents: next.focusedAgents }); }
    catch { setError('浏览器无法保存设置，请允许此页面使用本地存储后重试。'); }
  };
  useEffect(() => {
    if (!state?.scannedAt) return;
    let active = true;
    void request<{ annotations: AiAnnotation[] }>('/ai/annotations')
      .then(result => { if (active) setAnnotations(result.annotations); })
      .catch(error => { if (active) setError(`读取描述失败：${message(error)}`); });
    return () => { active = false; };
  }, [state]);
  const descriptions = useMemo(() => {
    const result: Record<string, AiAnnotation> = {};
    for (const skill of [...(state?.skills ?? []).flatMap(skill => [skill, ...(skill.installations ?? [])]), ...(state?.managedSkills ?? [])]) {
      const annotation = selectSkillAnnotation(annotations, skill.id, aiPreferences.targetLanguage, skill.description);
      if (annotation) result[skill.id] = annotation;
    }
    return result;
  }, [annotations, aiPreferences.targetLanguage, state]);
  const staleTranslationIds = useMemo(() => [...(state?.skills ?? []), ...(state?.managedSkills ?? [])].filter(skill => {
    const translation = getSkillTranslation(annotations, skill.id, aiPreferences.targetLanguage);
    return translation && (translation.stale || isLikelyIncompleteTranslation(skill.description, translation.text));
  }).map(skill => skill.id), [annotations, aiPreferences.targetLanguage, state]);
  const onAiSaved = async (annotation: AiAnnotation) => {
    setAnnotations(current => [...current.filter(item => !(item.skillId === annotation.skillId && item.kind === annotation.kind && item.language === annotation.language)), annotation]);
    await request<{ annotations: AiAnnotation[] }>('/ai/annotations').then(result => setAnnotations(result.annotations)).catch(error => setError(`更新 AI 注释失败：${message(error)}`));
  };
  const translateSkills = async (ids: string[]) => {
    if (translatingRef.current) return;
    translatingRef.current = true;
    setError(''); toast.info('正在翻译…');
    try { await translateDescriptions(ids, onAiSaved, text => toast.success(text)); }
    catch (error) { setError(message(error)); }
    finally { translatingRef.current = false; }
  };
  const importSkillsToPacks = async (ids: string[]) => {
    if (!state) return;
    const importedPaths = new Set(state.managedSkills.map(skill => skill.sourcePath));
    const pending = [...new Set(ids)].filter(id => state.skills.some(skill => skill.id === id && !importedPaths.has(skill.path)));
    if (!pending.length) { toast.success('所选 Skill 已经导入 Packs。'); return; }
    await act(() => mutate('/packs/default/skills', 'POST', { skillIds: pending }), `已导入 ${pending.length} 个 Skill 到 Packs。`, false);
  };
  useEffect(() => {
    localStorage.setItem('shelf-theme', JSON.stringify(theme));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { localStorage.setItem('shelf-finder-locations', JSON.stringify(finderLocations)); }, [finderLocations]);
  useEffect(() => { localStorage.setItem('shelf-sidebar-collapsed', JSON.stringify(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem('shelf-scope-collapsed', JSON.stringify(scopeCollapsed)); }, [scopeCollapsed]);
  useEffect(() => () => scopeResizeCleanup.current?.(), [scopeCollapsed]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const change = () => setIsMobile(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!sidebarOpen || !isMobile || dialog || detail) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = sidebarRef.current;
    if (!panel) return;
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
    controls()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); }
      if (event.key !== 'Tab') return;
      const items = controls();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); previous?.focus(); };
  }, [sidebarOpen, isMobile, dialog, detail]);

  const act = async (run: () => Promise<Snapshot>, success = '已保存', close = true) => {
    if (busy) return false;
    setBusy(true); setError('');
    try {
      const fresh = await run(); setState(fresh); toast.success(success);
      const validIds = new Set([...fresh.skills, ...fresh.skills.flatMap(skill => skill.installations || []), ...fresh.managedSkills].map(skill => skill.id));
      const validKeys = new Set([...validIds].map(id => `skill:${id}`));
      fresh.folders.forEach(folder => validKeys.add(`folder:${folder.id}`));
      setSelectedKeys(keys => keys.filter(key => validKeys.has(key)));
      if (close) setDialog(null);
      if (detail) {
        const family = fresh.skills.find(skill => skill.id === detail.id || skill.installations?.some(installation => installation.id === detail.id));
        const installation = family?.installations?.find(installation => installation.id === detail.id);
        setDetail(family ? family.id === detail.id ? family : installation ? { ...installation, installations: family.installations } : null : fresh.managedSkills.find(skill => skill.id === detail.id) || null);
      }
      return true;
    } catch (error) { setError(message(error)); return false; }
    finally { setBusy(false); }
  };
  const navigate = (newScope: string, newFolder: string | null = null) => {
    if (accessApplying) return;
    // As in the desktop Finder, a new folder inherits its current location's options.
    if (newScope === scope) {
      const nextLocation = `${newScope}:${newFolder || 'root'}`;
      setFinderLocations(current => current[nextLocation] ? current : { ...current, [nextLocation]: localStorage.getItem(`shelf-finder:${nextLocation}`) ? finderPreferences(nextLocation, defaultView) : preferences });
    }
    setHistory(current => {
      if (current.scope !== newScope) return { scope: newScope, entries: [newFolder], index: 0 };
      if (current.entries[current.index] === newFolder) return current;
      const entries = [...current.entries.slice(0, current.index + 1), newFolder]; return { scope: newScope, entries, index: entries.length - 1 };
    });
    setScope(newScope); setFolderId(newFolder); setScreen('shelf'); setSearch(''); setSearchDraft(''); setSelected([]); setDetail(null); setSidebarOpen(false);
  };
  const goHistory = (delta: number) => {
    const index = Math.max(0, Math.min(history.entries.length - 1, history.index + delta));
    const target = history.entries[index];
    setHistory({ ...history, index }); setFolderId(target && state?.folders.some(folder => folder.id === target) ? target : null); setSelected([]); setDetail(null); setSearch(''); setSearchDraft('');
  };

  const pack = state?.packs.find(pack => scope === `pack:${pack.id}`);
  const project = state?.projects.find(project => scope === `project:${project.id}`);
  const title = pack?.name || project?.name || '全局';
  const scopeSkills = useMemo(() => state ? (pack ? state.managedSkills : state.skills).filter(skill => skill.scopeId === scope) : [], [state, scope, pack]);
  const operations = useSkillsOperations({ state, scopeSkills: pack ? [] : scopeSkills, busy, onState: fresh => {
    setState(fresh);
    const validIds = new Set([...fresh.skills, ...fresh.skills.flatMap(skill => skill.installations || []), ...fresh.managedSkills].map(skill => skill.id));
    const keys = new Set([...validIds].map(id => `skill:${id}`));
    fresh.folders.forEach(folder => keys.add(`folder:${folder.id}`));
    setSelectedKeys(current => current.filter(key => keys.has(key)));
    setDetail(current => current ? [...fresh.skills, ...fresh.skills.flatMap(skill => skill.installations || []), ...fresh.managedSkills].find(skill => skill.id === current.id) || null : null);
    setAssistantSkill(current => current ? [...fresh.skills, ...fresh.skills.flatMap(skill => skill.installations || []), ...fresh.managedSkills].find(skill => skill.id === current.id) || null : null);
  }, onNotice: toast.success, onError: setError });
  const detailUpdateCheck = detail ? operations.updates?.checks[detail.id] : undefined;
  const detailUpdateFresh = Boolean(detailUpdateCheck && detailUpdateCheck.status !== 'unchecked' && Date.now() - Date.parse(detailUpdateCheck.checkedAt || '') <= 30 * 60_000);
  const detailCanUpdate = Boolean(detail && state?.skills.some(skill => skill.id === detail.id));
  const openSkill = (skill: Skill | ManagedSkill) => { setDetail(skill); if (assistantOpen) setAssistantSkill(skill); };
  const openAssistant = (skill: Skill | null = detail) => { setAssistantSkill(skill); setAssistantOpen(true); };
  const folders = state?.folders.filter(folder => folder.scopeId === scope) || [];
  const folder = folders.find(folder => folder.id === folderId);
  const query = search.trim().toLowerCase();
  const visibleSkills = scopeSkills.filter(skill => {
    const org = state ? organization(state, skill.id) : { folderId: null, tags: [] };
    if (!pack && operations.matchingIds && !operations.matchingIds.has(skill.id)) return false;
    return query ? [skill.name, skill.description, descriptions[skill.id]?.text || '', skill.sourceLabel, ...skill.agents, ...org.tags].join(' ').toLowerCase().includes(query) : !pack && operations.matchingIds ? true : org.folderId === folderId;
  }).sort((a, b) => a.name.localeCompare(b.name));
  const visibleFolders = !pack && operations.matchingIds ? [] : query ? pack ? folders.filter(folder => folder.name.toLowerCase().includes(query)) : [] : folders.filter(folder => folder.parentId === folderId);
  const openCreateFolder = (position?: Position) => setDialog({ kind: 'folder', position: position || defaultCanvasPosition(visibleFolders.length + visibleSkills.length) });
  const ancestors: Folder[] = [];
  let parent = folder;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) { ancestors.unshift(parent); seen.add(parent.id); parent = folders.find(folder => folder.id === parent!.parentId); }

  const dropInto = (event: React.DragEvent, target: string | null) => {
    if (query || busy) return;
    event.preventDefault(); event.currentTarget.classList.remove('drop-target');
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-skill-shelf')) as { scope: string; keys: string[] };
      if (!state || payload.scope !== scope || !Array.isArray(payload.keys)) return;
      const items = movableItems(payload.keys, finderItems(state, scope), folders).map(item => ({ kind: item.kind, id: item.id }));
      void act(() => mutate('/finder', 'PATCH', { scopeId: scope, items, parentId: target }), '已移动到文件夹', false).then(success => { if (success) setSelected([]); });
    } catch { /* Ignore drops from outside the workbench. */ }
  };
  const dragProps = (target: string | null) => ({
    'data-finder-folder-id': target || '__root__',
    onDragOver: (event: React.DragEvent) => { if (!query && !busy && event.dataTransfer.types.includes('application/x-skill-shelf')) { event.preventDefault(); event.currentTarget.classList.add('drop-target'); } },
    onDragLeave: (event: React.DragEvent) => event.currentTarget.classList.remove('drop-target'),
    onDrop: (event: React.DragEvent) => dropInto(event, target),
  });
  const confirmDelete = (skill: ManagedSkill) => setDialog({ kind: 'confirm', title: `删除「${skill.name}」？`, description: '只删除 Pack 中的托管副本，不会改动原始 Skill。已部署的复制文件会保留；仍有符号链接部署时需先移除部署。', run: () => mutate(`/managed/${pathId(skill.id)}`, 'DELETE') });
  const deleteFolder = (folder: Folder) => setDialog({ kind: 'confirm', title: `删除文件夹「${folder.name}」？`, description: '只删除文件夹整理记录，其中的 Skill 与子文件夹会回到上一级，标签保留。不会删除任何 Skill 文件。', run: async () => { const fresh = await mutate(`/folders/${pathId(folder.id)}`, 'DELETE'); if (folderId === folder.id) navigate(scope, folder.parentId); return fresh; } });
  const openSkillFolder = (id: string) => { void request('/skill/open-folder', 'POST', { id }).catch(error => setError(message(error))); };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError('文件过大，请选择小于 100 MiB 的 Pack JSON 文件。'); return; }
    try {
      const document = JSON.parse(await file.text()) as { format?: string };
      if (document.format === 'skill-shelf-metadata') {
        packImportFocus.current = window.document.activeElement as HTMLElement;
        setError(''); setPackResolutions({});
        setPackPreview(await request<SyncPreview>('/packs/preview', 'POST', { document }));
        return;
      }
      await act(() => mutate('/packs/import', 'POST', { document }), 'Pack 已导入');
    } catch (error) { setError(`无法读取 Pack：${message(error)}`); }
  };
  const scopeBounds = () => {
    const available = (sidebarRef.current?.parentElement?.clientWidth || window.innerWidth) - (sidebarCollapsed ? 64 : 200);
    const max = Math.floor(Math.min(360, available - Math.min(360, available * .6)));
    return { min: Math.min(180, max), max };
  };
  const saveScopeWidth = (requested: number) => {
    const { min, max } = scopeBounds();
    const next = Math.round(Math.min(max, Math.max(min, requested)));
    setScopeWidth(next); localStorage.setItem('shelf-scope-width', JSON.stringify(next));
  };
  const resizeScope = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !scopePanelRef.current || isMobile) return;
    event.preventDefault(); scopeResizeCleanup.current?.();
    const panel = scopePanelRef.current; const startX = event.clientX; const startWidth = panel.clientWidth;
    const { min, max } = scopeBounds(); let latest = startWidth;
    const move = (event: PointerEvent) => { latest = Math.min(max, Math.max(min, startWidth + event.clientX - startX)); panel.style.width = `${latest}px`; };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); scopeResizeCleanup.current = null; };
    const finish = () => { cleanup(); saveScopeWidth(latest); };
    scopeResizeCleanup.current = cleanup;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true });
  };

  if (!state) return <main className="boot-screen"><Brand /><h1>Skill Shelf</h1>{error ? <><div className="error-banner" role="alert">{error}</div><ShelfButton variant="default" size="sm" onClick={() => { setError(''); void request<Snapshot>('/state').then(setState).catch(error => setError(message(error))); }}>重新连接</ShelfButton></> : <div className="loading-line"><Loader2 className="spin" size={16} />正在加载已安装的 Skill</div>}</main>;

  const clearSearch = () => { setSearch(''); setSearchDraft(''); setSelected([]); searchRef.current?.focus(); };
  const openSettings = (section: SettingsSection = 'general') => { if (accessApplying) return; setPreviousScreen(screen === 'settings' ? previousScreen : screen); setSettingsSection(section); setScreen('settings'); setDetail(null); setSelected([]); setSidebarOpen(false); };
  const openDiscover = () => { if (accessApplying) return; setScreen('discover'); setDetail(null); setSelected([]); setSidebarOpen(false); };
  const openWorkbench = () => { if (accessApplying) return; setScreen('workbench'); setDetail(null); setSelected([]); setSidebarOpen(false); };
  const refreshWorkbench = async () => {
    if (busy) throw new Error('扫描正在进行，请稍后再试。');
    setBusy(true); setError('');
    try { setState(await mutate('/rescan', 'POST')); }
    finally { setBusy(false); }
  };
  const deletePack = () => pack && setDialog({ kind: 'confirm', title: `删除「${pack.name}」？`, description: '这会删除 Pack 及其全部托管副本。原始 Skills 不受影响；仍有符号链接部署时需先移除部署。', run: async () => { const fresh = await mutate(`/packs/${pathId(pack.id)}`, 'DELETE'); navigate('pack:default'); return fresh; } });

  return <div className="app-shell desktop-shell" data-sidebar-collapsed={sidebarCollapsed}>
    <header className="desktop-status-bar">
      <div className="status-sidebar-toggle">{screen === 'settings' ? <button className="status-back" onClick={() => setScreen(previousScreen)}><ArrowLeft size={14} />返回</button> : <><IconButton label="打开侧边栏" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)}><Menu size={16} /></IconButton><IconButton label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} className="icon-button desktop-sidebar-toggle" aria-controls="desktop-primary-navigation" aria-expanded={!sidebarCollapsed} onClick={() => { setSidebarCollapsed(!sidebarCollapsed); savePortablePreferences({ sidebarCollapsed: !sidebarCollapsed }); }}><PanelLeft size={14} /></IconButton></>}</div>
      <span className="status-title">{screen === 'settings' ? t('desktop.nav.settings') : screen === 'workbench' ? t('desktop.nav.workbench') : screen === 'discover' ? t('desktop.nav.discover') : pack ? t('desktop.nav.managed') : t('desktop.nav.library')}</span>
      <div className="status-actions"><IconButton label="打开 AI 助手" aria-expanded={assistantOpen} onClick={() => assistantOpen ? setAssistantOpen(false) : openAssistant()}><Bot size={14} /></IconButton>{screen !== 'shelf' && <IconButton label="重新扫描" disabled={busy || accessApplying} onClick={() => void act(() => mutate('/rescan', 'POST'), '扫描完成', false)} data-testid="rescan"><RefreshCw size={14} className={busy ? 'spin' : ''} /></IconButton>}</div>
    </header>
    <div className="desktop-body" data-view={screen}>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} />}
    {screen !== 'settings' && <aside ref={sidebarRef} className={`navigation-panels${sidebarOpen ? ' sidebar-open' : ''}`} aria-label="主导航" aria-hidden={isMobile && !sidebarOpen} inert={isMobile && !sidebarOpen}>
      <div className="primary-sidebar" data-collapsed={sidebarCollapsed} id="desktop-primary-navigation">
        <a className="sidebar-brand" href="#" aria-label="Skill Shelf" onClick={event => { event.preventDefault(); openWorkbench(); }}><Brand compact={sidebarCollapsed && !isMobile} /></a>
        <nav className="primary-navigation" aria-label={t('desktop.nav.main')} inert={accessApplying}>
          <button className={`primary-nav-item${screen === 'workbench' ? ' is-active' : ''}`} aria-current={screen === 'workbench' ? 'page' : undefined} title={t('desktop.nav.workbench')} onClick={openWorkbench}><Gauge size={18} /><span>{t('desktop.nav.workbench')}</span></button>
          <button className={`primary-nav-item${screen === 'shelf' && !pack ? ' is-active' : ''}`} aria-current={screen === 'shelf' && !pack ? 'page' : undefined} title={t('desktop.nav.library')} onClick={() => navigate('global')}><Library size={18} /><span>{t('desktop.nav.library')}</span><small>{state.skills.length}</small></button>
          <button className={`primary-nav-item${screen === 'discover' ? ' is-active' : ''}`} aria-current={screen === 'discover' ? 'page' : undefined} title={t('desktop.nav.discover')} onClick={openDiscover}><Compass size={18} /><span>{t('desktop.nav.discover')}</span></button>
          <button className={`primary-nav-item${screen === 'shelf' && pack ? ' is-active' : ''}`} aria-current={screen === 'shelf' && pack ? 'page' : undefined} title={t('desktop.nav.managed')} onClick={() => navigate('pack:default')}><Boxes size={18} /><span>{t('desktop.nav.managed')}</span></button>
        </nav>
        <nav className="sidebar-settings" aria-label={t('desktop.nav.applicationSettings')} inert={accessApplying}><button className="primary-nav-item" title={t('desktop.nav.settings')} onClick={() => openSettings()}><Settings size={18} /><span>{t('desktop.nav.settings')}</span></button></nav>
      </div>
      {screen === 'shelf' && (scopeCollapsed && !isMobile ? <button className="scope-panel-rail" aria-label={pack ? '展开 Packs' : '展开安装范围'} aria-expanded="false" onClick={() => setScopeCollapsed(false)}><ChevronRight size={12} /></button> : <div ref={scopePanelRef} className="library-scope-panel" style={isMobile ? undefined : { width: scopeWidth }}>
        <div className="skill-drawer-resize-handle scope-panel-resize-handle" role="separator" aria-label="调整安装范围侧栏宽度" aria-orientation="vertical" aria-valuemin={scopeBounds().min} aria-valuemax={scopeBounds().max} aria-valuenow={Math.round(scopeWidth)} tabIndex={0} onDoubleClick={() => saveScopeWidth(200)} onPointerDown={resizeScope} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); saveScopeWidth(event.key === 'Home' ? scopeBounds().min : event.key === 'End' ? scopeBounds().max : scopeWidth + (event.key === 'ArrowRight' ? 24 : -24)); } }}><span /></div>
        <header className="scope-panel-header"><div className="scope-panel-title"><span>{pack ? 'Packs' : '安装范围'}</span><button className="scope-panel-collapse" aria-label={pack ? '收起 Packs' : '收起安装范围'} aria-expanded="true" onClick={() => setScopeCollapsed(true)}><PanelLeftClose size={14} />收起</button></div><p>{pack ? '选择一个 Pack 查看其中的 Skill' : '选择全局，或直接打开一个已添加项目。'}</p></header>
        {pack ? <section className="scope-projects managed-pack-section"><header><div><strong>Packs</strong><span>{state.packs.length}</span></div><IconButton label="新建 Pack" onClick={() => setDialog({ kind: 'pack' })} data-testid="create-pack"><Plus size={14} /></IconButton></header><nav className="scope-filter-list scope-pack-list managed-pack-list" aria-label="Packs">{[...state.packs].sort((a, b) => Number(b.id === 'default') - Number(a.id === 'default')).map(item => <button key={item.id} className={scope === `pack:${item.id}` ? 'is-active' : ''} aria-current={scope === `pack:${item.id}` ? 'page' : undefined} onClick={() => navigate(`pack:${item.id}`)} data-testid={`pack-${item.id}`}><span className="scope-filter-icon"><Boxes size={14} /></span><span><strong>{item.name}</strong><small>{item.description || '每个 Pack 独立保存完整的 Skill 副本，可以整理并分享。'}</small></span><b>{state.managedSkills.filter(skill => skill.packId === item.id).length}</b></button>)}</nav></section> : <><nav className="scope-filter-list" aria-label="安装范围"><button className={scope === 'global' ? 'is-active' : ''} aria-current={scope === 'global' ? 'page' : undefined} onClick={() => navigate('global')}><span className="scope-filter-icon is-global"><Globe2 size={14} /></span><span><strong>全局</strong><small>这台 Mac 的共享目录</small></span><b>{state.skills.filter(skill => skill.scopeId === 'global').length}</b></button></nav><section className="scope-projects"><header><div><strong>项目</strong><span>{state.projects.length}</span></div><IconButton label="添加项目" onClick={() => setDialog({ kind: 'project' })}><FolderPlus size={14} /></IconButton></header><div className="scope-project-list">{state.projects.map(item => <article className={`scope-project-item${scope === `project:${item.id}` ? ' is-active' : ''}`} key={item.id}><button className="scope-project-target" title={item.path} aria-current={scope === `project:${item.id}` ? 'page' : undefined} onClick={() => navigate(`project:${item.id}`)}><FolderIcon size={16} /><span><strong>{item.name}</strong><small>{state.skills.filter(skill => skill.scopeId === `project:${item.id}`).length} 个 Skill</small><code>{item.path}</code></span></button><IconButton label={`移除项目 ${item.name}`} disabled={busy} onClick={() => setDialog({ kind: 'confirm', title: `移除项目「${item.name}」？`, description: '仅断开项目的扫描与整理记录，不会删除项目或原始 Skills。', run: async () => { const fresh = await mutate(`/projects/${pathId(item.id)}`, 'DELETE'); if (scope === `project:${item.id}`) navigate('global'); return fresh; } })}><Trash2 size={12} /></IconButton></article>)}{state.projects.length === 0 && <div className="scope-project-empty"><FolderPlus size={18} /><p>添加项目后，这里会显示目录别名和本地路径。</p><ShelfButton variant="outline" size="sm" onClick={() => setDialog({ kind: 'project' })}>添加项目</ShelfButton></div>}</div></section></>}
        {!pack && <p className="scope-panel-hint">文件夹在访达画布中管理，并按全局或项目范围相互独立。</p>}
      </div>)}
    </aside>}

    <main className="workspace desktop-main">
      {screen === 'settings' ? <SettingsWorkspace state={state} section={settingsSection} onSection={setSettingsSection} theme={theme} onTheme={next => { setTheme(next); savePortablePreferences({ theme: next }); }} preferences={uiPreferences} onPreferences={updateUiPreferences} busy={busy} onSynced={setState}
        onAddRoot={() => setDialog({ kind: 'root' })} onAddProject={() => setDialog({ kind: 'project' })}
        onRemoveRoot={root => setDialog({ kind: 'confirm', title: '移除扫描来源？', description: '将停止扫描这个目录，不会删除任何原始 Skill 文件。Pack 中的独立副本不受影响。', run: () => mutate(`/roots/${pathId(root.id)}`, 'DELETE') })}
        onRemoveProject={project => setDialog({ kind: 'confirm', title: `移除项目「${project.name}」？`, description: '仅断开项目的扫描与整理记录，不会删除项目或原始 Skills。', run: async () => { const fresh = await mutate(`/projects/${pathId(project.id)}`, 'DELETE'); if (scope === `project:${project.id}`) { setScope('global'); setFolderId(null); } return fresh; } })}
        onImport={() => fileRef.current?.click()} onExport={id => { const target = state.packs.find(pack => pack.id === id); if (target) void exportPack(target.id, target.name).catch(error => setError(message(error))); }} onNotice={toast.success} onError={setError}
      /> : screen === 'workbench' ? <Workbench state={state} focusedAgents={uiPreferences.focusedAgents} onManageAgents={() => openSettings('skills')} onRefresh={refreshWorkbench} busy={busy} onError={setError} onApplyingChange={setAccessApplying} /> : screen === 'discover' ? <DiscoverWorkspace state={state} onState={setState} onNotice={toast.success} /> : <div className="shelf-page">
        <div className="page-heading finder-page-header" data-slot="page-header"><div><h1>{title}</h1><p>{pack ? pack.description || '在这个集合包内独立管理分组、标签与 Skill 顺序。' : <span className="library-page-description"><span>像访达文件一样整理已录入的 Skill；文件夹和位置只保存在客户端本机。</span><span className="library-page-tip"><kbd>右键</kbd><span>画布空白处，可新建本地文件夹</span></span></span>}</p></div>
          <div className="heading-actions">{project && <ProjectInstructionsButton key={project.id} project={project} disabled={busy} onNotice={toast.success} />}{pack ? <><div className="managed-pack-actions"><button className="text-button" onClick={() => void exportPack(pack.id, pack.name).catch(error => setError(message(error)))}><ArrowDownToLine size={14} />导出 Pack</button><button className="text-button" disabled={pack.id === 'default'} onClick={() => setDialog({ kind: 'pack', pack })}><PencilLine size={14} />编辑 Pack</button><IconButton label="删除 Pack" disabled={pack.id === 'default' || busy} onClick={deletePack}><Trash2 size={14} /></IconButton></div><ShelfButton variant="default" size="sm" onClick={() => setDialog({ kind: 'import', packId: pack.id })} disabled={busy} data-testid="add-to-pack"><FolderInput size={14} />导入已安装 Skill</ShelfButton></> : <>{operations.toolbar}<ShelfButton size="sm" disabled={busy || operations.busy} onClick={openDiscover}><PackagePlus />{t('desktop.library.add')}</ShelfButton></>}</div>
        </div>
        <div className="finder-navigation"><div className="finder-history-controls" role="group" aria-label="文件夹导航"><IconButton label="后退" disabled={history.index === 0} onClick={() => goHistory(-1)}><ArrowLeft size={13} /></IconButton><IconButton label="前进" disabled={history.index === history.entries.length - 1} onClick={() => goHistory(1)}><ArrowRight size={13} /></IconButton></div><nav className="breadcrumb" aria-label="文件夹位置"><button {...dragProps(null)} onClick={() => navigate(scope)}><HardDrive size={13} />{title}</button>{ancestors.map(item => <span className="crumb-part" key={item.id}><ChevronRight size={12} /><button {...dragProps(item.id)} onClick={() => navigate(scope, item.id)}>{item.name}</button></span>)}</nav><div className="toolbar-controls"><div className="view-switch library-view-switcher finder-view-switcher" role="group" aria-label="显示方式">{([{ value: 'grid', label: '图标视图', icon: Grid2X2 }, { value: 'list', label: '列表视图', icon: List }, { value: 'columns', label: '分栏视图', icon: Columns3 }] as const).map(item => <button key={item.value} aria-label={item.label} title={item.label} aria-pressed={view === item.value} className={view === item.value ? 'active' : ''} onClick={() => setView(item.value)}><item.icon size={14} /></button>)}</div><div id="finder-arrangement-controls" /><button className="finder-new-folder" onClick={() => openCreateFolder()} disabled={busy}><FolderPlus size={14} />新建文件夹</button></div></div>
        <div className="content-toolbar finder-toolbar"><form className="search-control" onSubmit={event => { event.preventDefault(); setSearch(searchDraft.trim()); setSelected([]); }}><label className="search-box"><Search size={14} /><Input ref={searchRef} aria-label={pack ? '搜索 Packs' : '搜索已安装的 Skill'} placeholder={pack ? '搜索当前 Pack' : '搜索名称、来源和标签'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSearch(); } }} value={searchDraft} onChange={event => { setSearchDraft(event.target.value); if (!event.target.value) clearSearch(); }} />{(searchDraft || search) && <IconButton label="清除搜索" onClick={clearSearch}><X size={14} /></IconButton>}</label><ShelfButton variant="outline" size="sm" type="submit"><Search size={14} />筛选</ShelfButton></form><div className="library-toolbar-meta">{pack ? <span className="managed-skill-count">{query ? visibleSkills.length : scopeSkills.length} 个 Skill</span> : <span className="result-count">{visibleSkills.length + visibleFolders.length} {query ? '个 Skill' : '个项目'}</span>}</div>{!pack && operations.legend}</div>

        {((scopeSkills.length === 0 && folders.length === 0) || (query && visibleFolders.length === 0 && visibleSkills.length === 0)) ? <section className="empty-state"><BookOpen size={26} /><h2>{query ? '没有匹配的 Skill' : pack ? '这个 Pack 还没有 Skill' : '尚未发现已安装的 Skill'}</h2><p>{query ? '试试其他名称、来源或标签。' : pack ? '将已安装的 Skill 完整复制到这个 Pack。' : '重新扫描已有 Skills，或在设置中添加扫描来源。'}</p>{query ? <ShelfButton variant="outline" size="sm" onClick={clearSearch}>清除搜索</ShelfButton> : pack ? <ShelfButton variant="default" size="sm" onClick={() => setDialog({ kind: 'import', packId: pack.id })}><Plus size={14} />导入已安装 Skill</ShelfButton> : <div className="heading-actions"><ShelfButton variant="default" size="sm" disabled={busy} onClick={() => void act(() => mutate('/rescan', 'POST'), '扫描完成', false)}><RefreshCw size={14} />重新扫描</ShelfButton><ShelfButton variant="outline" size="sm" onClick={() => openSettings('skills')}>管理扫描来源</ShelfButton></div>}</section> : <FinderWorkspace finderOptions={preferences} onFinderOptionsChange={setFinderOptions} annotations={descriptions} snapshot={state} scope={scope} folderId={folderId} title={title} query={query} view={view} busy={operations.busy} updatingSkillIds={operations.updatingSkillIds} staleTranslationIds={staleTranslationIds} selection={selectedKeys} onSelection={setSelectedKeys} onNavigate={id => navigate(scope, id)} onOpenSkill={openSkill} matchingIds={pack ? null : operations.matchingIds} onUpdate={ids => operations.requestUpdate(ids)} updateChecks={pack ? undefined : operations.updates?.checks} onCloseSkill={() => setDetail(null)}
          selectedSkillId={detail?.id || null} onCreateFolder={openCreateFolder} onEditFolder={folder => setDialog({ kind: 'folder', folder })}
          onTranslate={ids => void translateSkills(ids)} onOpenFolder={openSkillFolder} onOrganizeSkill={skill => setDialog({ kind: 'pack-organize', skill })} onDeleteFolder={deleteFolder} onImport={ids => void importSkillsToPacks(ids)} onDeploy={ids => setDialog({ kind: 'deploy', ids })} onDeleteSkill={confirmDelete}
          onCommit={move => act(() => mutate('/finder', 'PATCH', move), 'Finder 整理已保存', false)} onView={setView} />}

      </div>}
    {screen === 'shelf' && detail && <SkillInspector removalAction={!('packId' in detail) ? <SkillRemovalButton skill={detail} disabled={busy || operations.busy} onState={fresh => { setState(fresh); setDetail(null); }} onNotice={toast.success} /> : undefined} key={detail.id} skill={detail} onInstallation={openSkill} state={state} focusedAgents={uiPreferences.focusedAgents} busy={operations.busy} onSaved={onAiSaved} renderFiles={id => <SkillFilesPanel skillId={id} />} updateAction={!detailCanUpdate ? undefined : {
      label: operations.updatingSkillIds.includes(detail.id) ? '正在更新…' : detailUpdateFresh ? '更新' : '检查并更新',
      disabled: operations.busy || (detailUpdateFresh && detailUpdateCheck?.status !== 'update-available'),
      running: operations.updatingSkillIds.includes(detail.id), onClick: () => void operations.requestUpdate([detail.id]),
    }} onOpenSource={detail.sourceUrl ? () => window.open(detail.sourceUrl, '_blank', 'noopener,noreferrer') : undefined} onClose={() => setDetail(null)} onOpenAiSettings={() => openSettings('ai-models')} onTags={tags => act(() => mutate('/organization', 'PATCH', { ids: [detail.id], tags }), '标签已保存', false)} onFolder={folderId => act(() => mutate('/organization', 'PATCH', { ids: [detail.id], folderId }), '文件夹已保存', false)} onDeploy={() => setDialog({ kind: 'deploy', ids: [detail.id] })} onOpenFolder={() => openSkillFolder(detail.id)} onRemoveDeployment={deploymentId => setDialog({ kind: 'confirm', title: '移除这次部署？', description: '插件会删除目标位置中未被修改的部署文件。用户改动过的复制目录或被替换的链接不会被删除。', run: () => mutate('/deployments/remove', 'POST', { skillId: detail.id, deploymentId }) })} />}
    </main>
    {assistantOpen && screen !== 'settings' && <aside className="assistant-utility-panel" aria-label="AI 助手"><AiAssistantSidebar skill={assistantSkill} onClose={() => setAssistantOpen(false)} onOpenSettings={() => openSettings('ai-models')} onClearSkillContext={() => setAssistantSkill(null)} onRestoreSkillContext={id => setAssistantSkill([...state.skills, ...state.skills.flatMap(skill => skill.installations || []), ...state.managedSkills].find(skill => skill.id === id) || null)} onSaved={onAiSaved} /></aside>}
    </div>

    <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label="导入 Pack JSON" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    {operations.dialogs}
    {packPreview && <SyncPreviewDialog preview={packPreview} origin="file" resolutions={packResolutions} unresolved={packPreview.conflicts.filter(conflict => !packResolutions[conflict.id]).length} working={busy} error={error} returnFocus={packImportFocus.current}
      onClose={() => { setPackPreview(null); setError(''); }} onChoose={(id, value) => setPackResolutions(current => ({ ...current, [id]: value }))}
      onChooseAll={value => setPackResolutions(Object.fromEntries(packPreview.conflicts.map(conflict => [conflict.id, value])))}
      onApply={() => { void act(async () => { const result = await request<{ snapshot: Snapshot }>('/sync/apply', 'POST', { previewId: packPreview.id, resolutions: packResolutions }); return result.snapshot; }, 'Pack 已导入', false).then(success => { if (success) setPackPreview(null); }); }} />}
    {dialog && <ActionDialog key={dialog.kind + ('mode' in dialog ? dialog.mode : '')} dialog={dialog} state={state} scope={scope} folderId={folderId} busy={busy} error={error} onClose={() => setDialog(null)} onAction={act} onNavigate={navigate} />}

  </div>;
}

type SkillFileEntry = { name: string; path: string; kind: 'file' | 'directory'; children?: SkillFileEntry[]; size?: number };

function SkillFilesPanel({ skillId }: { skillId: string }) {
  const [tree, setTree] = useState<{ files: SkillFileEntry[]; truncated: boolean } | null>(null);
  const [treeError, setTreeError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [loading, setLoading] = useState(false);
  const [rendered, setRendered] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setTree(null); setTreeError(''); setSelectedPath(null); setExpanded(new Set());
    void request<{ files: SkillFileEntry[]; truncated: boolean }>(`/skill/files?id=${pathId(skillId)}`, 'GET', undefined, true, controller.signal).then(result => {
      if (!active) return;
      setTree(result);
      const findFile = (entries: SkillFileEntry[]): string | null => {
        const skill = entries.find(entry => entry.kind === 'file' && /^skill\.md$/i.test(entry.name));
        if (skill) return skill.path;
        for (const entry of entries) { if (entry.kind === 'file') return entry.path; const child = findFile(entry.children || []); if (child) return child; }
        return null;
      };
      setSelectedPath(findFile(result.files));
    }).catch(error => { if (active) setTreeError(message(error)); });
    return () => { active = false; controller.abort(); };
  }, [skillId, refresh]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setContent(''); setContentError(''); setRendered(true); setLoading(Boolean(selectedPath));
    if (selectedPath) void request<{ path: string; text: string }>(`/skill/file?id=${pathId(skillId)}&path=${pathId(selectedPath)}`, 'GET', undefined, true, controller.signal).then(result => { if (active) setContent(result.text); })
      .catch(error => { if (active) setContentError(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [skillId, selectedPath]);
  const filePaths = useMemo(() => {
    const paths = new Set<string>();
    const visit = (entries: SkillFileEntry[]) => { for (const entry of entries) { if (entry.kind === 'file') paths.add(entry.path); else visit(entry.children || []); } };
    visit(tree?.files || []);
    return paths;
  }, [tree]);
  const linkedFile = (href: string) => {
    if (!selectedPath || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
    try {
      const base = `https://skill-files.invalid/${selectedPath.split('/').map(encodeURIComponent).join('/')}`;
      const url = new URL(href, base);
      if (url.origin !== 'https://skill-files.invalid') return null;
      const target = decodeURIComponent(url.pathname.slice(1));
      return filePaths.has(target) ? target : null;
    } catch { return null; }
  };
  const entries = (items: SkillFileEntry[], depth = 0): ReactNode => items.map(entry => <div key={entry.path} role="none"><button role="treeitem" aria-level={depth + 1} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} aria-selected={selectedPath === entry.path} className={`skill-file-entry${selectedPath === entry.path ? ' is-active' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} title={entry.path} onClick={() => {
    if (entry.kind === 'file') setSelectedPath(entry.path);
    else setExpanded(current => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
  }}>{entry.kind === 'directory' ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<FolderIcon size={14} /></> : <><span className="file-chevron-space" /><FileText size={14} /></>}<span>{entry.name}</span></button>{entry.kind === 'directory' && expanded.has(entry.path) && <div role="group">{entries(entry.children || [], depth + 1)}</div>}</div>);
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(selectedPath || '');
  return <div className="skill-file-browser"><aside className="skill-file-tree"><header><strong>文件</strong></header>{treeError ? <div className="file-tree-error"><p>{treeError}</p><button className="text-button" onClick={() => setRefresh(value => value + 1)}>重试</button></div> : !tree ? <div className="loading-line"><Loader2 className="spin" size={14} />读取文件…</div> : <><div role="tree" aria-label="Skill 文件">{entries(tree.files)}</div>{tree.truncated && <p className="file-tree-hint">文件较多，仅显示部分目录。</p>}</>}</aside><section className="skill-file-preview markdown-section"><header className="markdown-heading"><h3>{selectedPath || '文件预览'}</h3>{isMarkdown && <div className="file-markdown-mode"><button aria-pressed={rendered} onClick={() => setRendered(true)}>渲染</button><button aria-pressed={!rendered} onClick={() => setRendered(false)}>源码</button></div>}</header><div className="skill-file-preview-scroll">{loading ? <div className="loading-line"><Loader2 className="spin" size={14} />读取文件内容…</div> : contentError ? <div className="error-banner" role="alert">{contentError}</div> : !selectedPath ? <p className="file-tree-hint">选择一个文件以查看内容。</p> : isMarkdown && rendered ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span className="markdown-image">[图片：{alt || '未命名'}；为保护隐私不自动加载]</span>, a: ({ href, children }) => {
    const target = href ? linkedFile(href) : null;
    if (target) return <a href="#skill-files-panel" onClick={event => { event.preventDefault(); setExpanded(current => { const next = new Set(current); const parts = target.split('/'); for (let index = 1; index < parts.length; index++) next.add(parts.slice(0, index).join('/')); return next; }); setSelectedPath(target); }}>{children}</a>;
    if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    return <span className="markdown-unavailable-link" title="该链接不在当前 Skill 的可预览文件中">{children}</span>;
  } }}>{markdownBody(content) || '此文件暂无内容。'}</ReactMarkdown></div> : <pre className="skill-file-source"><code>{content}</code></pre>}</div></section></div>;
}

function ActionDialog({ dialog, state, scope, folderId, busy, error, onClose, onAction, onNavigate }: {
  dialog: DialogState; state: Snapshot; scope: string; folderId: string | null;
  busy: boolean; error: string; onClose: () => void;
  onAction: (run: () => Promise<Snapshot>, success?: string, close?: boolean) => Promise<boolean>;
  onNavigate: (scope: string, folder?: string | null) => void;
}) {
  const existingPack = dialog.kind === 'pack' ? dialog.pack : undefined;
  const existingFolder = dialog.kind === 'folder' ? dialog.folder : undefined;
  const organizingSkill = dialog.kind === 'pack-organize' ? dialog.skill : undefined;
  const selectedPack = state.packs.find(pack => pack.id === (organizingSkill?.packId || (dialog.kind === 'import' ? dialog.packId : undefined)));
  const [name, setName] = useState(existingPack?.name || existingFolder?.name || '');
  const [description, setDescription] = useState(existingPack?.description || '');
  const [path, setPath] = useState('');
  const [color, setColor] = useState(existingFolder?.color || '#ed6a4a');
  const [targetFolder, setTargetFolder] = useState(organizingSkill ? organization(state, organizingSkill.id).folderId || '' : '');
  const [packId] = useState(dialog.kind === 'import' ? dialog.packId || 'default' : 'default');
  const [ids, setIds] = useState<string[]>(dialog.kind === 'import' ? dialog.ids || [] : []);
  const [query, setQuery] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [importScope, setImportScope] = useState<'all' | 'global' | 'project'>('all');
  const importSearchRef = useRef<HTMLInputElement>(null);
  const [tags, setTags] = useState(organizingSkill ? organization(state, organizingSkill.id).tags.join(', ') : '');
  const parsedTags = [...new Set(tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
  const [mode, setMode] = useState<'copy' | 'symlink'>('copy');
  const folders = state.folders.filter(folder => folder.scopeId === scope);
  const [localError, setLocalError] = useState('');
  const title = dialog.kind === 'pack' ? existingPack ? '编辑 Pack' : '新建 Pack' : dialog.kind === 'folder' ? existingFolder ? '重命名文件夹' : '创建文件夹' : dialog.kind === 'pack-organize' ? `整理 ${dialog.skill.name}` : dialog.kind === 'import' ? selectedPack ? `导入到 ${selectedPack.name}` : '导入到 Packs' : dialog.kind === 'deploy' ? '部署 Skills' : dialog.kind === 'root' ? '连接 Skill 来源' : dialog.kind === 'project' ? '连接项目' : dialog.title;
  const buttonText = dialog.kind === 'import' ? `导入 ${ids.length} 个` : dialog.kind === 'deploy' ? '部署到目标目录' : dialog.kind === 'confirm' ? '确认删除' : dialog.kind === 'pack' || dialog.kind === 'pack-organize' ? '保存 Pack' : dialog.kind === 'folder' ? existingFolder ? '重命名文件夹' : '创建文件夹' : '创建';

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    if ((dialog.kind === 'root' || dialog.kind === 'project' || dialog.kind === 'deploy') && !/^(\/|[A-Za-z]:[\\/])/.test(path.trim())) { setLocalError('请输入本机绝对路径，例如 /Users/you/skills。'); return; }
    if (dialog.kind === 'pack') {
      const body = { name: name.trim(), description: description.trim() };
      await onAction(async () => {
        const fresh = await mutate(existingPack ? `/packs/${pathId(existingPack.id)}` : '/packs', existingPack ? 'PATCH' : 'POST', body);
        if (!existingPack) { const created = fresh.packs.find(pack => !state.packs.some(existing => existing.id === pack.id)); if (created) onNavigate(`pack:${created.id}`); }
        return fresh;
      }, existingPack ? 'Pack 已更新' : 'Pack 已创建');
    } else if (dialog.kind === 'folder') {
      await onAction(() => mutate(existingFolder ? `/folders/${pathId(existingFolder.id)}` : '/folders', existingFolder ? 'PATCH' : 'POST', existingFolder ? { name: name.trim() } : { name: name.trim(), color, scopeId: scope, parentId: folderId, ...(dialog.position ? { position: dialog.position } : {}) }), existingFolder ? '文件夹已重命名。' : '文件夹已创建。');
    } else if (dialog.kind === 'pack-organize') {
      if (parsedTags.length > 12 || parsedTags.some(tag => tag.length > 32)) { setLocalError('最多 12 个标签，每个最多 32 个字符。'); return; }
      await onAction(() => mutate('/organization', 'PATCH', { ids: [dialog.skill.id], folderId: targetFolder || null, tags: parsedTags }), 'Pack 已保存。');
    } else if (dialog.kind === 'import') {
      if (!ids.length) { setLocalError('请至少选择一个 Skill。'); return; }
      await onAction(() => mutate(`/packs/${pathId(packId)}/skills`, 'POST', { skillIds: ids, ...(scope === `pack:${packId}` ? { folderId } : {}) }), 'Skills 已复制到 Pack');
    } else if (dialog.kind === 'deploy') {
      await onAction(() => mutate('/deploy', 'POST', { skillIds: dialog.ids, targetPath: path.trim(), mode }), 'Skills 已部署');
    } else if (dialog.kind === 'root') {
      await onAction(() => mutate('/roots', 'POST', { path: path.trim(), ...(name.trim() ? { label: name.trim() } : {}) }), '来源已连接');
    } else if (dialog.kind === 'project') {
      await onAction(() => mutate('/projects', 'POST', { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }), '项目已连接');
    } else await onAction(dialog.run, '已删除');
  };
  const installed = state.skills.filter(skill => (importScope === 'all' || (importScope === 'global' ? skill.scopeId === 'global' : skill.scopeId.startsWith('project:'))) && [skill.name, skill.description, skill.sourceLabel, state.projects.find(project => skill.scopeId === `project:${project.id}`)?.name || ''].join(' ').toLowerCase().includes(query.toLowerCase()));
  const folderPath = (id: string) => {
    const parts: string[] = []; const seen = new Set<string>(); let current = folders.find(folder => folder.id === id);
    while (current && !seen.has(current.id)) { seen.add(current.id); parts.unshift(current.name); current = folders.find(folder => folder.id === current!.parentId); }
    return parts.join(' / ');
  };
  const clearImportSearch = () => { setQuery(''); setQueryDraft(''); importSearchRef.current?.focus(); };
  const validFolderName = name.trim().length > 0 && name.length <= 48 && !folders.some(folder => folder.id !== existingFolder?.id && folder.parentId === (existingFolder?.parentId ?? folderId) && folder.name.trim().toLowerCase() === name.trim().toLowerCase());

  return <Modal title={title} onClose={onClose} busy={busy} className={dialog.kind === 'folder' ? 'folder-dialog' : ['pack', 'pack-organize', 'import'].includes(dialog.kind) ? 'managed-dialog' : ''}><form onSubmit={submit} className={`dialog-form${dialog.kind === 'folder' ? ' create-folder-form' : dialog.kind === 'pack' ? ' managed-pack-form' : ''}`}>
    {dialog.kind === 'pack' && <><p className="dialog-intro">每个 Pack 独立保存完整的 Skill 副本，可以整理并分享。</p><Field label="Pack 名称"><Input autoComplete="off" required maxLength={64} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="说明"><Textarea rows={2} maxLength={500} value={description} onChange={event => setDescription(event.target.value)} /></Field></>}
    {dialog.kind === 'folder' && <><p className="dialog-intro">{existingFolder ? '只修改 Skill Shelf 中显示的名称，不会修改任何 Skill 文件。' : '文件夹只保存在 Skill Shelf 本机数据中，不会移动或修改 Skill 文件。'}</p><Input className="folder-name-input" aria-label="文件夹名称" autoFocus required maxLength={48} value={name} onFocus={event => { if (existingFolder) event.currentTarget.select(); }} onChange={event => setName(event.target.value)} />{!existingFolder && <div className="color-options color-picker" role="radiogroup" aria-label="文件夹颜色">{['#ed6a4a', '#cb8b24', '#358b68', '#3e77c7', '#8a63a8', '#767672'].map(value => <button key={value} type="button" role="radio" aria-label={`颜色 ${value}`} aria-checked={color === value} style={{ background: value }} onClick={() => setColor(value)}>{color === value && <Check size={15} />}</button>)}</div>}</>}
    {dialog.kind === 'pack-organize' && <><p className="dialog-intro">分组与标签仅在当前 Pack 内生效。</p><Field label="文件夹"><ShelfSelect aria-label="文件夹" disabled={busy} value={targetFolder} onValueChange={setTargetFolder} options={[{ value: '', label: selectedPack?.name || 'Default' }, ...folders.map(folder => ({ value: folder.id, label: folderPath(folder.id) }))]} /></Field><Field label="标签" hint="用逗号分隔，最多 12 个标签，每个最多 32 个字符。"><Input aria-label="标签" disabled={busy} maxLength={500} value={tags} onChange={event => setTags(event.target.value)} /></Field></>}
    {dialog.kind === 'import' && <><p className="dialog-intro">{selectedPack ? `选中的 Skill 会完整复制到 ${selectedPack.name}，与其他 Pack 中的副本独立。` : '选中的 Skill 文件夹会复制到 Skill Shelf 的应用数据目录，不会修改原始文件。'}</p>{!dialog.ids ? <><div className="managed-import-controls"><div className="managed-import-search"><label className="search-box dialog-search"><Search size={14} /><Input ref={importSearchRef} aria-label="搜索已安装 Skill" value={queryDraft} placeholder="搜索名称、来源、项目和描述" onChange={event => { setQueryDraft(event.target.value); if (!event.target.value) clearImportSearch(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setQuery(queryDraft.trim()); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearImportSearch(); } }} />{(queryDraft || query) && <IconButton label="清除搜索" onClick={clearImportSearch}><X size={12} /></IconButton>}</label><ShelfButton variant="outline" size="sm" type="button" onClick={() => setQuery(queryDraft.trim())}><Search size={14} />搜索</ShelfButton></div><ShelfSelect aria-label="按安装位置筛选" value={importScope} onValueChange={value => setImportScope(value as typeof importScope)} options={[{ value: 'all', label: '全部位置' }, { value: 'global', label: '全局' }, { value: 'project', label: '项目' }]} /></div><div className="managed-import-summary"><span>可导入 {installed.length} 个 · 已选择 {ids.length} 个</span><div><button type="button" disabled={!installed.length} onClick={() => setIds(current => [...new Set([...current, ...installed.map(skill => skill.id)])])}>选择当前结果</button><button type="button" disabled={!ids.length} onClick={() => setIds([])}>清空</button></div></div><div className="managed-selection-list is-import-list">{installed.map(skill => <button className={`managed-selection-row${ids.includes(skill.id) ? ' is-selected' : ''}`} aria-pressed={ids.includes(skill.id)} key={skill.id} type="button" onClick={() => setIds(current => current.includes(skill.id) ? current.filter(id => id !== skill.id) : [...current, skill.id])}><span>{ids.includes(skill.id) && <Check size={13} />}</span><div><strong>{skill.name}</strong><small>{state.projects.find(project => skill.scopeId === `project:${project.id}`)?.name || '从全局导入'}</small></div></button>)}{installed.length === 0 && <p>{state.skills.length ? '没有符合搜索条件的已安装 Skill。' : '尚未发现已安装的 Skill。'}</p>}</div></> : <div className="selected-preview">{state.skills.filter(skill => ids.includes(skill.id)).map(skill => <span key={skill.id}><FileText size={14} />{skill.name}</span>)}</div>}</>}
    {dialog.kind === 'deploy' && <><p className="dialog-intro">将 {dialog.ids.length} 个 Pack Skills 部署到本机目标目录。每个 Skill 都会创建独立的子目录。</p><Field label="目标目录（绝对路径）" hint="例如 /Users/you/project/.claude/skills"><Input required spellCheck={false} placeholder="/Users/you/project/.claude/skills" value={path} onChange={event => setPath(event.target.value)} /></Field><div className="deploy-mode"><button type="button" className={mode === 'copy' ? 'active' : ''} onClick={() => setMode('copy')}><Copy size={19} /><strong>复制文件</strong><small>独立副本，适合分享与稳定使用</small>{mode === 'copy' && <Check size={15} />}</button><button type="button" className={mode === 'symlink' ? 'active' : ''} onClick={() => setMode('symlink')}><Link2 size={19} /><strong>符号链接</strong><small>指向托管文件，依赖此 Pack 存在</small>{mode === 'symlink' && <Check size={15} />}</button></div><div className="info-note"><ShieldCheck size={16} /><span>绝不覆盖目标中已有的文件或目录。如果有冲突，整次部署会取消。</span></div></>}
    {(dialog.kind === 'root' || dialog.kind === 'project') && <><p className="dialog-intro">{dialog.kind === 'project' ? '连接本机项目目录，单独整理项目中的 Skills。' : '插件会扫描目录中的 SKILL.md，只读取原始文件。你可以连接一个 Skill 或包含多个 Skills 的目录。'}</p><Field label={dialog.kind === 'project' ? '项目路径（绝对路径）' : 'Skill 目录（绝对路径）'}><Input required spellCheck={false} placeholder={dialog.kind === 'project' ? `${state.homeDir}/projects/my-project` : `${state.homeDir}/.claude/skills`} value={path} onChange={event => setPath(event.target.value)} /></Field><Field label="显示名称（可选）"><Input placeholder="留空使用目录名" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field><div className="info-note"><HardDrive size={15} />连接与扫描都在本机完成，不会上传任何文件。</div></>}
    {dialog.kind === 'confirm' && <p className="confirm-description">{dialog.description}</p>}
    {(localError || error) && <div className="error-banner" role="alert">{localError || error}</div>}
    <div className="dialog-actions"><ShelfButton variant="outline" size="sm" type="button" onClick={onClose} disabled={busy}>取消</ShelfButton><ShelfButton size="sm" variant={dialog.kind === 'confirm' ? 'destructive' : 'default'} type="submit" disabled={busy || (dialog.kind === 'import' && ids.length === 0) || (dialog.kind === 'pack' && !name.trim()) || (dialog.kind === 'folder' && !validFolderName) || (dialog.kind === 'pack-organize' && (parsedTags.length > 12 || parsedTags.some(tag => tag.length > 32)))}>{busy ? <Loader2 className="spin" size={15} /> : dialog.kind === 'confirm' ? <Trash2 size={15} /> : dialog.kind === 'import' ? <FolderInput size={15} /> : dialog.kind === 'pack' ? <Check size={15} /> : null}{busy ? '正在处理…' : buttonText}</ShelfButton></div>
  </form></Modal>;
}
