import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, Download, ExternalLink, FolderOpen, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import ShelfButton from './ShelfButton';
import ShelfDialog, { DialogTitle, DialogDescription } from './ShelfDialog';
import ShelfSelect from './ShelfSelect';
import { Input } from './ShelfForm';
import { request } from './api';
import type { Snapshot } from './types';
import { t } from './desktop-ui';
import './discover-workspace.css';

type Agent = { id: string; name: string; scopes: ('global' | 'project')[] };
type Entry = { kind: 'skill' | 'topic' | 'creator' | 'repository'; name: string; repo?: string; skill?: string; description?: string; url: string; path?: string; installCount?: number; installLabel?: string; countLabel?: string };
type Catalog = { entries: Entry[]; section: string; title?: string; description?: string; sourceUrl: string; fetchedAt: string; stale?: boolean; warning?: string };
type Detail = { name: string; repo: string; skill: string; url: string; sourceUrl: string; description: string; document: string; warning?: string };
type Task = { status: 'running' | 'succeeded' | 'failed'; message: string; outputLines?: string[]; installedNames?: string[] };
type Props = { state: Snapshot; onState: (state: Snapshot) => void; onNotice: (message: string) => void; onError?: (message: string) => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const tabs = [{ id: 'home', name: t('desktop.discover.home') }, { id: 'topics', name: t('desktop.discover.topics') }, { id: 'official', name: t('desktop.discover.official') }];
const leaderboards = ['trending', 'hot', 'all'].map(id => ({ id, name: t(`desktop.discover.native.leaderboard.${id}`) }));
const sections = [...leaderboards, { id: 'topics', name: t('desktop.discover.native.topics.title') }, { id: 'official', name: t('desktop.discover.native.official.title') }];

export function DiscoveryDialog({ title, description, locked = false, onClose, children, className = '' }: { title: string; description: string; locked?: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const descriptionId = useId();
  return <ShelfDialog className={`discovery-dialog ${className}`} locked={locked} onClose={onClose} aria-describedby={descriptionId}>
    <header className="discovery-dialog-header" data-slot="dialog-header"><div><DialogTitle asChild><h2>{title}</h2></DialogTitle><DialogDescription asChild><p id={descriptionId}>{description}</p></DialogDescription></div></header>{children}
  </ShelfDialog>;
}

export function InstallSourceButton(props: Props & { disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return <><ShelfButton size="sm" variant="outline" disabled={props.disabled} onClick={() => setOpen(true)}><Plus />{props.label ?? '从来源安装'}</ShelfButton>{open && <InstallDialog {...props} onClose={() => setOpen(false)} />}</>;
}

function InstallDialog({ state, onState, onNotice, onClose, source: initialSource = '', skill: initialSkill = '' }: Props & { onClose: () => void; source?: string; skill?: string }) {
  const [source, setSource] = useState(initialSource), [skills, setSkills] = useState(initialSkill);
  const [scope, setScope] = useState<'global' | 'project'>('global'), [projectId, setProjectId] = useState(state.projects[0]?.id ?? '');
  const [agents, setAgents] = useState<Agent[]>([]), [agentIds, setAgentIds] = useState<string[]>([...new Set(['universal', ...(state.portablePreferences?.defaultAgents ?? [])])]);
  const [agentQuery, setAgentQuery] = useState(''), [agentRevision, setAgentRevision] = useState(0), [agentLoading, setAgentLoading] = useState(true);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [task, setTask] = useState<Task | null>(null), [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setAgentLoading(true); setError('');
    void request<Agent[]>('/skills/install/agents', 'GET', undefined, true, controller.signal).then(setAgents).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setAgentLoading(false); });
    return () => controller.abort();
  }, [agentRevision]);
  useEffect(() => {
    if (!busy) return;
    let active = true;
    const timer = setInterval(() => { void request<{ task: Task | null }>('/skills/install/status').then(value => { if (active && value.task) setTask(value.task); }).catch(() => {}); }, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [busy]);
  const supported = agents.filter(agent => agent.scopes.includes(scope));
  const availableIds = agentIds.filter(id => supported.some(agent => agent.id === id));
  const change = (action: () => void) => { action(); setConfirmed(false); setTask(null); setError(''); };
  async function install() {
    setBusy(true); setError(''); setTask({ status: 'running', message: '正在下载并验证 Skill，暂不改动现有目录。' });
    try {
      const result = await request<{ state: Snapshot; message: string; task: Task }>('/skills/install', 'POST', { source, skillNames: skills.split(',').map(name => name.trim()).filter(Boolean), target: { scope, ...(scope === 'project' ? { projectId } : {}) }, agents: availableIds, confirmed: true });
      setTask(result.task); onState(result.state); onNotice('Skill 安装完成。');
    } catch (error) {
      setError(errorText(error));
      try { const status = await request<{ task: Task | null }>('/skills/install/status'); if (status.task) setTask(status.task); } catch { /* Keep the original operation error visible. */ }
    } finally { setBusy(false); }
  }
  const completed = task?.status === 'succeeded';
  return <DiscoveryDialog title={t('desktop.installDialog.title')} description="使用与桌面版相同的 Skills CLI 1.5.23。来源内容不会自动执行，已有目录不会被覆盖。" locked={busy} onClose={onClose} className="discovery-install-dialog">
    <div className="discovery-dialog-body">
      {!completed && <fieldset className="discovery-install-fields" disabled={busy}>
        <label>安装来源<Input value={source} onChange={event => change(() => setSource(event.target.value))} placeholder="owner/repository 或 GitHub / skills.sh URL" autoFocus={!initialSource} /></label>
        <small>支持 GitHub 仓库、skills.sh Skill 链接、绝对本地目录，以及仅包含 add / --skill 的安装命令。</small>
        <label>指定 Skill（可选）<Input value={skills} onChange={event => change(() => setSkills(event.target.value))} placeholder="用逗号分隔名称；留空安装来源中的全部 Skill" /></label>
        <div className="discovery-target-fields"><label>安装范围<ShelfSelect aria-label="安装范围" value={scope} onValueChange={value => change(() => setScope(value as 'global' | 'project'))} options={[{ value: 'global', label: '全局 · 当前用户' }, { value: 'project', label: '项目', disabled: !state.projects.length }]} disabled={busy} /></label>
          {scope === 'project' && <label>目标项目<ShelfSelect aria-label="目标项目" value={projectId} onValueChange={value => change(() => setProjectId(value))} options={state.projects.map(project => ({ value: project.id, label: project.name }))} disabled={busy} /></label>}
        </div>
        <p className="discovery-target-path"><FolderOpen />{scope === 'global' ? `${state.homeDir}/.agents/skills` : `${state.projects.find(project => project.id === projectId)?.path ?? ''}/.agents/skills`}</p>
        <div className="discovery-agent-heading"><strong>接入 Agent</strong><span>{availableIds.length} 个已选</span></div>
        <Input aria-label="搜索安装 Agent" value={agentQuery} onChange={event => setAgentQuery(event.target.value)} placeholder="搜索 Agent" />
        {agentLoading ? <p className="discovery-status"><LoaderCircle className="spin" />正在加载 Agent…</p> : agents.length ? <div className="discovery-agent-options">{supported.filter(agent => agent.name.toLowerCase().includes(agentQuery.toLowerCase())).map(agent => <label key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={event => change(() => setAgentIds(ids => event.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id)))} /><span>{agent.name}</span></label>)}</div> : <ShelfButton variant="outline" size="sm" onClick={() => setAgentRevision(value => value + 1)}>重试加载 Agent</ShelfButton>}
        <div className="discovery-safety-note"><ShieldCheck /><span>Skill 先下载至隔离目录并验证，再写入共享目录。所选 Agent 通过链接接入；同名目录或安装记录已存在时会停止，不覆盖旧内容。{!skills.trim() && '当前将安装来源中的全部 Skill。'}</span></div>
        <label className="discovery-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>我信任此来源，并确认安装范围、Skill 选择和 Agent 目标。</span></label>
      </fieldset>}
      {task && <section className={`discovery-task is-${task.status}`} aria-live="polite"><strong>{task.status === 'running' ? <LoaderCircle className="spin" /> : task.status === 'succeeded' ? <CheckCircle2 /> : null}{task.status === 'succeeded' ? '安装完成' : task.status === 'failed' ? '安装未完成' : '正在安装'}</strong><p>{task.message}</p>{task.installedNames?.length ? <p>{task.installedNames.join('、')}</p> : null}{task.outputLines?.length ? <details><summary>查看安装输出</summary><pre>{task.outputLines.join('\n')}</pre></details> : null}</section>}
      {error && <p className="discovery-error" role="alert">{error}</p>}
    </div>
    <footer className="discovery-dialog-footer"><ShelfButton variant="outline" disabled={busy} onClick={onClose}>{completed ? '关闭' : '取消'}</ShelfButton>{!completed && <ShelfButton disabled={busy || !confirmed || !source.trim() || !availableIds.length || agentLoading || (scope === 'project' && !projectId)} onClick={() => void install()}>{busy ? <LoaderCircle className="spin" /> : <Download />}{busy ? '正在安装…' : '确认安装'}</ShelfButton>}</footer>
  </DiscoveryDialog>;
}

export default function DiscoverWorkspace(props: Props) {
  const [section, setSection] = useState('trending'), [path, setPath] = useState(''), [parent, setParent] = useState('trending');
  const [leaderboard, setLeaderboard] = useState('trending');
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null), [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState('');
  const [install, setInstall] = useState<{ source: string; skill: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const parameters = new URLSearchParams({ section, query, ...(path ? { path } : {}), ...(revision ? { refresh: 'true' } : {}) });
    void request<Catalog>(`/discovery/catalog?${parameters}`, 'GET', undefined, true, controller.signal).then(setCatalog).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [section, path, query, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setDetail(null); setDetailError('');
    void request<Detail>('/discovery/detail', 'POST', { url: selected.url }, true, controller.signal).then(setDetail).catch(error => { if (!controller.signal.aborted) setDetailError(errorText(error)); });
    return () => controller.abort();
  }, [selected]);
  const atRoot = sections.some(item => item.id === section);
  const rootSection = atRoot ? section : parent;
  const activeTab = rootSection === 'topics' || rootSection === 'official' ? rootSection : 'home';
  function navigate(next: string, nextPath = '') { setSection(next); if (leaderboards.some(item => item.id === next)) setLeaderboard(next); setPath(nextPath); setDraft(''); setQuery(''); setCatalog(null); setError(''); }
  function open(entry: Entry) {
    if (entry.kind === 'skill') setSelected(entry);
    else { if (atRoot) setParent(section); navigate(entry.kind === 'creator' ? 'creator' : entry.kind === 'repository' ? 'repository' : 'topic', entry.path); }
  }
  return <section className="discover-workspace">
    <header className="discover-page-header" data-slot="page-header"><div data-slot="page-header-heading"><p className="discovery-eyebrow" data-slot="page-header-eyebrow">{t('desktop.discover.eyebrow')}</p><h1>{t('desktop.discover.title')}</h1><p data-slot="page-header-description">{t('desktop.discover.description')}</p></div><div data-slot="page-header-actions"><a className="shelf-button shelf-button-size-sm shelf-button-variant-outline" data-slot="button" data-size="sm" data-variant="outline" href="https://skills.sh" target="_blank" rel="noreferrer">{t('desktop.discover.browse')}<ArrowUpRight /></a></div></header>
    <nav className="discover-tabs" aria-label={t('desktop.discover.sections')}>{tabs.map(tab => <ShelfButton key={tab.id} size="sm" variant={activeTab === tab.id ? 'secondary' : 'ghost'} aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => navigate(tab.id === 'home' ? leaderboard : tab.id)}>{tab.name}</ShelfButton>)}</nav>
    <div className="discovery-catalog"><div className="discovery-toolbar">{activeTab === 'home' && atRoot ? <div className="discovery-leaderboard-switcher" role="group" aria-label={t('desktop.discover.native.leaderboards')}>{leaderboards.map(item => <button key={item.id} type="button" className={section === item.id ? 'is-active' : ''} aria-pressed={section === item.id} onClick={() => navigate(item.id)}>{item.name}</button>)}</div> : <strong>{atRoot ? sections.find(item => item.id === section)?.name : catalog?.title || path}</strong>}<div className="discovery-tools"><InstallSourceButton {...props} /><ShelfButton size="icon-sm" variant="ghost" aria-label={t('desktop.discover.native.refresh')} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className={loading ? 'spin' : ''} /></ShelfButton><a className="discovery-external" aria-label={t('desktop.discover.native.openSource')} href={catalog?.sourceUrl ?? 'https://skills.sh'} target="_blank" rel="noreferrer">skills.sh<ExternalLink size={13} /></a></div></div>
      <form className="discovery-search" onSubmit={event => { event.preventDefault(); setCatalog(null); setQuery(draft.trim()); }}><Search size={16} /><Input aria-label={t('desktop.discover.search')} placeholder={t('desktop.discover.searchPlaceholder')} value={draft} onChange={event => setDraft(event.target.value)} />{draft && <ShelfButton size="icon-sm" variant="ghost" aria-label={t('desktop.discover.clearSearch')} onClick={() => { setDraft(''); setQuery(''); setCatalog(null); }}><X /></ShelfButton>}<ShelfButton size="sm" variant="outline" type="submit" disabled={loading}>{t('common.search')}</ShelfButton></form>
      {!atRoot && <div className="discovery-breadcrumb"><ShelfButton size="sm" variant="ghost" onClick={() => navigate(parent)}><ArrowLeft />返回{sections.find(item => item.id === parent)?.name}</ShelfButton><strong>{catalog?.title || path}</strong></div>}
      <div className="discovery-results-summary"><span>{query ? `“${query}” 的${t('desktop.discover.searchResults')}` : atRoot ? sections.find(item => item.id === section)?.name : catalog?.title || path}{catalog ? ` · ${catalog.entries.length} 项` : ''}</span>{catalog?.fetchedAt && <small>{catalog.stale ? t('desktop.discover.native.cached') : t('desktop.discover.native.updated', { time: new Date(catalog.fetchedAt).toLocaleTimeString() })}</small>}</div>
      {catalog?.warning && <p className="discovery-warning" role="status">{catalog.warning}</p>}
      {error && <div className="discovery-empty"><p className="discovery-error" role="alert">{error}</p><ShelfButton variant="outline" onClick={() => setRevision(value => value + 1)}>重试</ShelfButton></div>}
      {loading && !catalog ? <div className="discovery-loading" role="status"><LoaderCircle className="spin" /><p>{t('desktop.discover.native.loading')}</p></div> : catalog && <div className={`discovery-results${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>{catalog.entries.length ? catalog.entries.map((entry, index) => <article className="discovery-result" key={entry.url}><span className="discovery-result-rank">{entry.kind === 'skill' ? String(index + 1).padStart(2, '0') : <FolderOpen size={17} />}</span><button className="discovery-result-main" type="button" onClick={() => open(entry)}><strong>{entry.name}</strong><span>{entry.repo || entry.description || (entry.kind === 'creator' ? t('desktop.discover.native.official.title') : '')}</span>{entry.kind === 'skill' && entry.description && <p>{entry.description}</p>}</button><span className="discovery-install-count">{entry.installLabel ?? (entry.installCount === undefined ? entry.countLabel : entry.installCount.toLocaleString())}{entry.kind === 'skill' && entry.installCount !== undefined && <small>安装次数</small>}</span><ShelfButton size="sm" variant="ghost" onClick={() => entry.kind === 'skill' ? setInstall({ source: entry.repo!, skill: entry.skill! }) : open(entry)}>{entry.kind === 'skill' ? <><Download />安装</> : <><ArrowUpRight />查看</>}</ShelfButton></article>) : <div className="discovery-empty"><Search /><h3>{t('desktop.discover.noResults')}</h3><p>试试其他关键词，或直接从仓库安装。</p></div>}</div>}
    </div>
    <p className="discovery-footnote"><ShieldCheck size={14} />市场信息来自 skills.sh。安装次数不代表安全性；使用前请检查来源和 Skill 内容。</p>
    {selected && <DiscoveryDialog title={selected.name} description={selected.repo ?? ''} onClose={() => setSelected(null)} className="discovery-detail-dialog"><div className="discovery-dialog-body">{detail ? <><p className="discovery-detail-description">{detail.description}</p>{detail.warning && <p className="discovery-warning">{detail.warning}</p>}{detail.document ? <pre className="discovery-document">{detail.document}</pre> : <p className="discovery-empty">该页面未提供可读取的 Skill 正文，可打开原页面查看。</p>}<div className="discovery-detail-links"><a href={detail.url} target="_blank" rel="noreferrer">skills.sh 详情<ArrowUpRight size={14} /></a><a href={detail.sourceUrl} target="_blank" rel="noreferrer">GitHub 来源<ArrowUpRight size={14} /></a></div></> : detailError ? <p role="alert" className="discovery-error">{detailError}</p> : <p className="discovery-status"><LoaderCircle className="spin" />正在读取详情…</p>}</div><footer className="discovery-dialog-footer"><ShelfButton variant="outline" onClick={() => setSelected(null)}>关闭</ShelfButton><ShelfButton onClick={() => { setInstall({ source: selected.repo!, skill: selected.skill! }); setSelected(null); }}><Download />安装此 Skill</ShelfButton></footer></DiscoveryDialog>}
    {install && <InstallDialog {...props} source={install.source} skill={install.skill} onClose={() => setInstall(null)} />}
  </section>;
}
