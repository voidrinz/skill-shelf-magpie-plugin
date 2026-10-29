import ShelfButton from './ShelfButton';
import ShelfDialog, { DialogTitle, DialogDescription } from './ShelfDialog';
import ShelfSwitch from './ShelfSwitch';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { VERSION, DESKTOP_BASELINE } from '../../src/version.mjs';
import { ArrowUpRight, BookOpen, Bot, Boxes, Check, Download, Eye, FolderPlus, HardDrive, Info, Keyboard, LoaderCircle, Monitor, Moon, Palette, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2, Upload, X } from 'lucide-react';
import AiSettings from './AiSettings';
import SyncSettings from './SyncSettings';
import ShelfSelect from './ShelfSelect';
import { Input } from './ShelfForm';
import { request } from './api';
import type { Project, Root, Snapshot, Theme } from './types';
import type { UiPreferences } from './ui-preferences';
import type { WorkbenchSnapshot } from './workbench-types';
import { t } from './desktop-ui';

export type SettingsSection = 'general' | 'appearance' | 'shortcuts' | 'skills' | 'data' | 'sync' | 'about' | 'ai-provider' | 'ai-models' | 'ai-behavior';
type Props = {
  state: Snapshot; section: SettingsSection; onSection: (section: SettingsSection) => void;
  theme: Theme; onTheme: (theme: Theme) => void; preferences: UiPreferences; onPreferences: (value: UiPreferences) => void;
  busy: boolean; onAddRoot: () => void; onRemoveRoot: (root: Root) => void;
  onAddProject: () => void; onRemoveProject: (project: Project) => void;
  onImport: () => void; onExport: (id: string) => void; onSynced: (snapshot: Snapshot) => void; onNotice: (text: string) => void; onError: (text: string) => void;
};
const applicationNavigation = [
  { id: 'general', label: t('desktop.settings.general'), icon: SlidersHorizontal }, { id: 'appearance', label: t('desktop.settings.appearance'), icon: Palette },
  { id: 'shortcuts', label: t('desktop.settings.shortcuts'), icon: Keyboard }, { id: 'skills', label: t('desktop.settings.skillsCli'), icon: HardDrive },
  { id: 'sync', label: t('desktop.sync.title'), icon: RefreshCw }, { id: 'about', label: t('desktop.settings.about'), icon: Info },
] as const;
const aiNavigation = [
  { id: 'ai-provider', label: t('desktop.settings.aiModelService'), icon: Bot }, { id: 'ai-models', label: t('desktop.settings.aiDefaultModels'), icon: Boxes },
  { id: 'ai-behavior', label: t('desktop.settings.aiBehavior'), icon: Sparkles },
] as const;
function Page({ title, status, children }: { title: string; status?: string; children: ReactNode }) {
  return <div className="settings-page"><header className="settings-page-header"><h2>{title}</h2>{status && <span className="is-success">{status}</span>}</header>{children}</div>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section"><h3>{title}</h3><div className="setting-rows">{children}</div></section>;
}
function Row({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><small>{description}</small></div>{children}</div>;
}


export default function SettingsWorkspace(props: Props) {
  const { state, section, onSection, preferences, onPreferences, busy } = props;
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentError, setAgentError] = useState('');
  const [agentRevision, setAgentRevision] = useState(0);
  const [agentLoading, setAgentLoading] = useState(false);
  const [detectedAgents, setDetectedAgents] = useState<string[]>([]);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentQueryDraft, setAgentQueryDraft] = useState('');
  const [agentQuery, setAgentQuery] = useState('');
  const agentSearch = useRef<HTMLInputElement>(null);
  const agentReturnFocus = useRef<HTMLElement | null>(null);
  const [exportId, setExportId] = useState('default');
  useEffect(() => {
    if (section !== 'skills') return;
    let active = true; setAgentError(''); setAgentLoading(true);
    void request<WorkbenchSnapshot>('/workbench').then(snapshot => { if (active) { setAgents(snapshot.registry.agents); setDetectedAgents(snapshot.agentCoverage.map(agent => agent.name)); } })
      .catch(() => { if (active) setAgentError('无法加载 Agent，请重试。'); })
      .finally(() => { if (active) setAgentLoading(false); });
    return () => { active = false; };
  }, [section, state.scannedAt, agentRevision]);
  const update = (patch: Partial<UiPreferences>) => onPreferences({ ...preferences, ...patch });
  const closeAgentDialog = () => { setAgentDialogOpen(false); setAgentQueryDraft(''); setAgentQuery(''); };
  const toggleAgent = (name: string) => {
    if (preferences.focusedAgents.includes(name)) update({ focusedAgents: preferences.focusedAgents.filter(agent => agent !== name) });
    else if (preferences.focusedAgents.length < 12) update({ focusedAgents: [...preferences.focusedAgents, name] });
  };
  const visibleAgents = agents.filter(agent => !agentQuery || agent.name.toLocaleLowerCase().includes(agentQuery.toLocaleLowerCase()))
    .sort((left, right) => Number(preferences.focusedAgents.includes(right.name)) - Number(preferences.focusedAgents.includes(left.name)) || left.name.localeCompare(right.name));
  const agentGroup = (detected: boolean) => {
    const entries = visibleAgents.filter(agent => detectedAgents.includes(agent.name) === detected);
    return entries.length ? <section className="agent-focus-section"><h4>{detected ? '这台电脑已检测到' : '其他兼容 Agent'}</h4><div>{entries.map(agent => {
      const selected = preferences.focusedAgents.includes(agent.name);
      return <button type="button" key={agent.id} aria-pressed={selected} className={selected ? 'is-selected' : ''} disabled={!selected && preferences.focusedAgents.length >= 12} onClick={() => toggleAgent(agent.name)}><span>{selected && <Check />}</span><div><strong>{agent.name}</strong><small>{detected ? '已检测到本地 Agent' : '兼容 Agent'}</small></div>{selected && <Eye />}</button>;
    })}</div></section> : null;
  };
  const rootRow = (root: Root) => <div className="source-row" key={root.id}><HardDrive size={18} /><div><strong>{root.label}</strong><code>{root.path}</code><small>{root.scopeId === 'global' ? '全局' : state.projects.find(project => root.scopeId === `project:${project.id}`)?.name || '项目'} · {root.preset ? '预设来源' : '自定义来源'}{!root.exists && ' · 目录未找到或无法访问'}</small></div>{!root.preset && <button className="icon-button" aria-label={`移除来源 ${root.label}`} disabled={busy} onClick={() => props.onRemoveRoot(root)}><Trash2 size={15} /></button>}</div>;
  const primaryModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const skillRoots = [...new Set(state.skills.map(skill => skill.path.replace(/\/[^/]+$/, '')))].sort();
  const shortcut = (label: string, description: string, keys: string[]) => <Row key={label} label={label} description={description}><span className="shortcut-keys" data-slot="kbd-group">{keys.map(key => <kbd key={key} data-slot="kbd">{key}</kbd>)}</span></Row>;
  const packFiles = <Section title="Pack 文件">
    <Row label="导入 Pack" description="恢复 Pack 中的 Skill、文件夹和标签，不覆盖原始 Skill。"><ShelfButton variant="outline" size="sm" data-slot="button" data-size="sm" disabled={busy} onClick={props.onImport}><Upload />导入 Pack 文件</ShelfButton></Row>
    <Row label="导出 Pack" description="导出完整 Pack，便于分享或备份。"><div className="settings-export"><ShelfSelect className="setting-select" aria-label="导出的 Pack" value={state.packs.some(pack => pack.id === exportId) ? exportId : 'default'} onValueChange={setExportId} options={state.packs.map(pack => ({ value: pack.id, label: pack.name }))} /><ShelfButton variant="outline" size="sm" data-slot="button" data-size="sm" disabled={busy} onClick={() => props.onExport(state.packs.some(pack => pack.id === exportId) ? exportId : 'default')}><Download />导出</ShelfButton></div></Row>
  </Section>;
  return <section className="settings-workspace">
    <nav className="settings-navigation" aria-label="设置分类"><h1>设置</h1><p>应用程序</p>
      {applicationNavigation.map(item => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}><item.icon /><span>{item.label}</span></button>)}
      <p className="settings-navigation-group">AI</p>
      {aiNavigation.map(item => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}><item.icon /><span>{item.label}</span></button>)}
    </nav>
    <div className="settings-content">
      {section.startsWith('ai-') ? <AiSettings section={section as 'ai-provider' | 'ai-models' | 'ai-behavior'} onNotice={props.onNotice} onError={props.onError} />
        : section === 'sync' ? <SyncSettings busy={busy} onSynced={props.onSynced} onNotice={props.onNotice} onError={props.onError} />
        : section === 'general' ? <Page title="通用"><Section title="启动">
          <Row label="启动页面" description="打开 Skill Shelf 时显示的页面。"><ShelfSelect className="setting-select" aria-label="启动页面" value={preferences.startupPage} onValueChange={value => update({ startupPage: value as UiPreferences['startupPage'] })} options={[{ value: 'workbench', label: '工作台' }, { value: 'skills', label: 'Skills' }, { value: 'packs', label: 'Packs' }]} /></Row>
          <Row label="记住上次位置" description="优先恢复上次打开的页面与文件夹。"><ShelfSwitch aria-label="记住上次位置" checked={preferences.rememberLocation} onCheckedChange={() => update({ rememberLocation: !preferences.rememberLocation })} /></Row>
        </Section></Page>
        : section === 'appearance' ? <Page title="外观"><Section title="界面">
          <Row label="主题" description="选择浅色、深色或跟随操作系统。"><div className="theme-setting" role="radiogroup" aria-label="外观主题">{([{ value: 'system', label: '跟随系统', icon: Monitor }, { value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }] as const).map(item => <button type="button" role="radio" aria-label={item.label} aria-checked={props.theme === item.value} key={item.value} tabIndex={props.theme === item.value ? 0 : -1} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const themes: Theme[] = ['system', 'light', 'dark']; const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (themes.indexOf(props.theme) + (event.key === 'ArrowRight' ? 1 : 2)) % 3; props.onTheme(themes[next]); (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus(); }} onClick={() => props.onTheme(item.value)}><item.icon size={14} /><span>{item.label}</span></button>)}</div></Row>
          <Row label="列表密度" description="影响 Skills 的列表与分栏视图。紧凑模式可显示更多行，舒适模式增加行间空间；图标画布保持原有布局。"><div role="tablist" aria-label="列表密度">{([{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }] as const).map(item => <button type="button" role="tab" tabIndex={preferences.density === item.value ? 0 : -1} aria-selected={preferences.density === item.value} data-state={preferences.density === item.value ? 'active' : 'inactive'} key={item.value} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'comfortable' : event.key === 'End' ? 'compact' : preferences.density === 'comfortable' ? 'compact' : 'comfortable'; update({ density: next }); (event.currentTarget.parentElement?.children[next === 'comfortable' ? 0 : 1] as HTMLElement | undefined)?.focus(); }} onClick={() => update({ density: item.value })}>{item.label}</button>)}</div></Row>
        </Section></Page>
        : section === 'shortcuts' ? <Page title="快捷键"><p className="shortcut-page-description">查看 Skill Shelf 当前已经支持的快捷操作；修饰键会自动适配当前操作系统。</p><Section title="Skill 浏览">
          {shortcut('全选可见项目', '选中列表或分栏视图中当前可见的全部文件夹与 Skill。', [primaryModifier, 'A'])}
          {shortcut('连续范围选择', '在列表或分栏视图中先选择一项，再按住 Shift 单击另一项。', ['Shift', '单击'])}
          {shortcut('增减选择项目', '在任意 Skill 视图中，按住主修饰键并单击一个项目。', [primaryModifier, '单击'])}
          {shortcut('清空选择', '清空列表视图或分栏视图中的当前选择。', ['Esc'])}
        </Section><Section title="Skill 详情面板">
          {shortcut('调整面板宽度', '聚焦拖动手柄后，按向左或向右方向键。', ['←', '→'])}
          {shortcut('切换到最小或最大宽度', '聚焦拖动手柄后，按 Home 或 End。', ['Home', 'End'])}
        </Section><Section title="搜索">{shortcut('搜索', '提交关键词筛选；Esc 清除搜索。', ['Enter', 'Esc'])}</Section></Page>
        : section === 'skills' || section === 'data' ? <Page title="Skills 与 Agent" status="已就绪">
          <Section title="已安装的 Skill"><Row label="检测到的根目录" description={`在全局与项目范围内检测到 ${state.skills.length} 个 Skill。`}><div className="path-values">{skillRoots.map(root => <code key={root} title={root}>{root}</code>)}{!skillRoots.length && <span>暂未检测到</span>}</div></Row></Section>
          <Section title="关注的 Agent"><Row label="展示优先级" description="在工作台和 Skill 详情中优先展示这些 Agent，不会改变安装位置。"><div className="focused-agent-setting"><div className="focused-agent-summary">{preferences.focusedAgents.length ? <>{preferences.focusedAgents.slice(0, 3).map(agent => <span key={agent} data-slot="badge" className="settings-badge"><Eye />{agent}</span>)}{preferences.focusedAgents.length > 3 && <span data-slot="badge" className="settings-badge is-outline">+{preferences.focusedAgents.length - 3}</span>}</> : <span>自动展示 · 未固定 Agent</span>}</div><ShelfButton variant="outline" size="xs" type="button"  data-slot="button" data-size="xs" disabled={agentLoading && !agents.length} onClick={event => { agentReturnFocus.current = event.currentTarget; setAgentDialogOpen(true); }}>{agentLoading ? <LoaderCircle className="spin" /> : <SlidersHorizontal />}管理</ShelfButton></div></Row>{agentError && <div className="settings-inline-error" role="alert">{agentError}<ShelfButton variant="outline" size="xs" data-slot="button" data-size="xs" onClick={() => setAgentRevision(value => value + 1)}>重试</ShelfButton></div>}</Section>
          <Section title="Skill Shelf 数据"><Row label="本地元数据" description="包含私有分组、标签以及这些偏好设置。"><div className="path-values"><code title={state.dataDir}>{state.dataDir}</code></div></Row></Section>
          {packFiles}
          <Section title="Skill 来源"><Row label="本机 Skill 目录" description="扫描这些目录中的 Skill，不修改原始文件。"><ShelfButton variant="outline" size="xs" data-slot="button" data-size="xs" disabled={busy} onClick={props.onAddRoot}><Plus />添加来源</ShelfButton></Row><details className="settings-source-details"><summary>管理扫描目录</summary>{state.roots.map(rootRow)}</details></Section>
          <Section title="项目目录"><Row label="项目专属 Skills" description="单独管理项目中的 Skill。"><ShelfButton variant="outline" size="xs" data-slot="button" data-size="xs" disabled={busy} onClick={props.onAddProject}><FolderPlus />添加项目</ShelfButton></Row>{state.projects.map(project => <div className="source-row" key={project.id}><FolderPlus size={18} /><div><strong>{project.name}</strong><code>{project.path}</code></div><button className="icon-button" aria-label={`移除项目 ${project.name}`} disabled={busy} onClick={() => props.onRemoveProject(project)}><Trash2 size={15} /></button></div>)}</Section>
          {state.scanWarnings.length > 0 && <Section title="扫描提醒"><div className="settings-inline-error">{state.scanWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></Section>}
          {agentDialogOpen && <ShelfDialog className="agent-focus-dialog" onClose={closeAgentDialog} returnFocus={agentReturnFocus.current} aria-labelledby="agent-focus-title" aria-describedby="agent-focus-description">

            <div data-slot="dialog-header"><DialogTitle id="agent-focus-title" data-slot="dialog-title">关注的 Agent</DialogTitle><DialogDescription id="agent-focus-description" data-slot="dialog-description">只选择你实际使用的工具。其他兼容 Agent 仍然可用，但会弱化或折叠展示。</DialogDescription></div>
            <form className="agent-focus-search" onSubmit={event => { event.preventDefault(); setAgentQuery(agentQueryDraft.trim()); }}><div className="agent-focus-search-field"><Search /><Input ref={agentSearch} type="search" aria-label="搜索 Agent" placeholder="搜索 Agent" value={agentQueryDraft} onChange={event => { setAgentQueryDraft(event.target.value); if (!event.target.value) setAgentQuery(''); }} onKeyDown={event => { if (event.key === 'Escape' && (agentQueryDraft || agentQuery)) { event.preventDefault(); event.stopPropagation(); setAgentQueryDraft(''); setAgentQuery(''); } }} />{(agentQueryDraft || agentQuery) && <button type="button" aria-label="清空 Agent 搜索" onClick={() => { setAgentQueryDraft(''); setAgentQuery(''); agentSearch.current?.focus(); }}><X /></button>}</div><ShelfButton variant="outline" size="sm" data-slot="button" data-size="sm" type="submit"><Search />搜索</ShelfButton></form>
            <div className="agent-focus-count"><span>已选择 {preferences.focusedAgents.length} 个</span>{preferences.focusedAgents.length > 0 && <ShelfButton variant="ghost" size="xs" onClick={() => update({ focusedAgents: [] })}>改用自动展示</ShelfButton>}</div>
            <div className="agent-focus-list">{visibleAgents.length ? <>{agentGroup(true)}{agentGroup(false)}</> : <div className="agent-focus-empty"><Search />{agentError || '没有匹配的 Agent'}</div>}</div>
            <div data-slot="dialog-footer"><span className="agent-focus-limit">最多关注 12 个 Agent</span><ShelfButton variant="default" size="sm" type="button"  data-slot="button" data-size="sm" onClick={closeAgentDialog}>关闭</ShelfButton></div>
          </ShelfDialog>}
        </Page>
        : <Page title="关于"><section className="about-app-card" aria-label="关于这个应用"><div className="about-identity"><span className="about-mark" aria-hidden="true"><BookOpen /></span><div><h3>Skill Shelf</h3><p>版本 {VERSION} · Magpie · 客户端基线 {DESKTOP_BASELINE}</p><p>发现、整理和管理你的 Skill。</p></div></div></section><Section title="本地数据"><div className="privacy-card"><ShieldCheck /><div><strong>你的 Skill 书架保存在这台电脑上。</strong><p>Skill 列表、分组、标签和偏好设置保存在本机。</p></div></div></Section><div className="about-actions"><ShelfButton asChild variant="outline" size="sm"><a href="https://skills.sh" target="_blank" rel="noreferrer">访问 skills.sh<ArrowUpRight /></a></ShelfButton></div></Page>}
    </div>
  </section>;
}
