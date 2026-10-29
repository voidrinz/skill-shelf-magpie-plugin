import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleArrowUp, CircleCheck, CircleDashed, CircleHelp, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import { request } from './api';
import ShelfButton from './ShelfButton';
import ShelfDialog, { DialogTitle, DialogDescription } from './ShelfDialog';
import type { Skill, Snapshot } from './types';
import './newskills-operations.css';

export type SkillUpdateStatus = 'current' | 'update-available' | 'missing' | 'unavailable' | 'unchecked';
export type SkillUpdateCheck = { status: SkillUpdateStatus; reason: string; checkedAt?: string };
export type SkillsUpdateSnapshot = {
  scanId: string | null; scannedAt: string | null; scanning: boolean; updating: boolean;
  completed: number; total: number; checks: Record<string, SkillUpdateCheck>; summary: Record<SkillUpdateStatus, number>;
};
type OperationResult = { success: boolean; message: string; outputLines?: string[]; state: Snapshot; updates: SkillsUpdateSnapshot; results?: { id: string; success: boolean; message: string }[] };
type Options = {
  state: Snapshot | null; scopeSkills: Skill[]; busy: boolean;
  onState: (state: Snapshot) => void; onNotice: (message: string) => void; onError: (message: string) => void;
};
const freshness = 30 * 60_000;
const statuses: SkillUpdateStatus[] = ['current', 'update-available', 'missing', 'unavailable', 'unchecked'];
const labels: Record<SkillUpdateStatus, string> = { current: '已是最新', 'update-available': '可更新', missing: '上游已移除', unavailable: '无法确认', unchecked: '待确认' };
const glyphs = { current: CircleCheck, 'update-available': CircleArrowUp, missing: CircleX, unavailable: CircleHelp, unchecked: CircleDashed };
const emptyCheck: SkillUpdateCheck = { status: 'unchecked', reason: 'not-scanned' };

function getScanState(skills: Skill[], updates: SkillsUpdateSnapshot | null, now: number) {
  let oldest = Infinity;
  for (const skill of skills) {
    const check = updates?.checks[skill.id] ?? emptyCheck;
    const time = Date.parse(check.checkedAt ?? '');
    if (check.status === 'unchecked' || !Number.isFinite(time)) return 'missing';
    oldest = Math.min(oldest, time);
  }
  return now - oldest > freshness ? 'stale' : 'fresh';
}

function operationError(caught: unknown, fallback: string) {
  const message = caught instanceof Error ? caught.message : '';
  if (message.includes('independent installation copies')) return '这个 Skill 有多个独立安装副本，请先检查安装位置。';
  if (/changed|Scan.*again|scan.*again|ready to update|before updating|Scan for updates/.test(message)) return 'Skill 或扫描结果已变化，请重新扫描后再更新。';
  if (message.includes('already running')) return '其他 Skill 操作正在进行，请稍后重试。';
  if (message.includes('project is no longer')) return '这个项目已不存在，请重新选择项目。';
  if (message.includes('installer is missing')) return '无法启动安装工具，请重新安装插件后重试。';
  return fallback;
}

export function useSkillsOperations(options: Options) {
  const { state, scopeSkills, onState, onNotice, onError } = options;
  const [updates, setUpdates] = useState<SkillsUpdateSnapshot | null>(null);
  const [filterStatus, setFilterStatus] = useState<SkillUpdateStatus | null>(null);
  const [action, setAction] = useState<'scan' | 'update' | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [pendingUpdate, setPendingUpdate] = useState<Skill[] | null>(null);
  const [updateError, setUpdateError] = useState('');
  const actionLock = useRef(false);
  const statusErrorShown = useRef(false);
  const callbacks = useRef(options); callbacks.current = options;
  const stateKey = state?.skills.map(skill => `${skill.id}:${skill.path}`).join('|') ?? '';
  useEffect(() => {
    const controller = new AbortController();
    void request<SkillsUpdateSnapshot>('/skills/status', 'GET', undefined, true, controller.signal)
      .then(value => { if (!controller.signal.aborted && !actionLock.current) { setUpdates(value); statusErrorShown.current = false; } })
      .catch(() => { if (!controller.signal.aborted && !statusErrorShown.current) { statusErrorShown.current = true; callbacks.current.onError('无法读取 Skill 更新状态，请重试扫描。'); } });
    return () => controller.abort();
  }, [stateKey]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      setClock(Date.now());
      if (actionLock.current) return;
      void request<SkillsUpdateSnapshot>('/skills/status', 'GET', undefined, true, controller.signal)
        .then(value => { if (!controller.signal.aborted && !actionLock.current) { setUpdates(value); statusErrorShown.current = false; } })
        .catch(() => { if (!controller.signal.aborted && !statusErrorShown.current) { statusErrorShown.current = true; callbacks.current.onError('无法读取 Skill 更新状态，请重试扫描。'); } });
    }, 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  useEffect(() => {
    if (!action) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void request<SkillsUpdateSnapshot>('/skills/status', 'GET', undefined, true, controller.signal)
        .then(value => { if (!controller.signal.aborted && actionLock.current) setUpdates(value); })
        .catch(() => { if (!controller.signal.aborted && !statusErrorShown.current) { statusErrorShown.current = true; callbacks.current.onError('暂时无法读取操作进度，请等待操作完成。'); } });
    }, 800);
    return () => { clearInterval(timer); controller.abort(); };
  }, [action]);
  const scanState = getScanState(scopeSkills, updates, clock);
  const counts = Object.fromEntries(statuses.map(status => [status, scopeSkills.filter(skill => (updates?.checks[skill.id]?.status ?? 'unchecked') === status).length])) as Record<SkillUpdateStatus, number>;
  const busy = options.busy || action !== null || Boolean(updates?.scanning || updates?.updating);
  const matchingIds = useMemo(() => filterStatus ? new Set(scopeSkills.filter(skill => (updates?.checks[skill.id]?.status ?? 'unchecked') === filterStatus).map(skill => skill.id)) : null, [filterStatus, scopeSkills, updates]);

  async function scanUpdates() {
    if (actionLock.current || busy) return null;
    actionLock.current = true; setAction('scan'); callbacks.current.onError('');
    try {
      const result = await request<{ state: Snapshot; updates: SkillsUpdateSnapshot }>('/skills/scan', 'POST', {});
      setUpdates(result.updates); setClock(Date.now()); statusErrorShown.current = false; callbacks.current.onState(result.state);
      callbacks.current.onNotice('扫描完成');
      return result;
    } catch (caught) { callbacks.current.onError(operationError(caught, '扫描更新失败，请稍后重试。')); return null; }
    finally { actionLock.current = false; setAction(null); }
  }

  async function requestScan() { await scanUpdates(); }

  async function requestUpdate(skillIds?: string[]) {
    if (actionLock.current || busy || !state) return;
    let currentUpdates = updates;
    let requested = skillIds ? state.skills.filter(skill => skillIds.includes(skill.id)) : scopeSkills;
    if (!currentUpdates?.scanId || getScanState(requested, currentUpdates, Date.now()) !== 'fresh') {
      if (!skillIds) { onError('请先扫描更新，再确认需要更新的 Skill。'); return; }
      const scanned = await scanUpdates();
      if (!scanned) return;
      currentUpdates = scanned.updates;
      requested = scanned.state.skills.filter(skill => skillIds.includes(skill.id));
    }
    const candidates = requested.filter(skill => currentUpdates.checks[skill.id]?.status === 'update-available');
    if (!candidates.length) { onNotice('当前没有可更新的 Skill。'); return; }
    setUpdateError(''); setPendingUpdate(candidates);
  }

  async function confirmUpdate() {
    if (!pendingUpdate || !updates?.scanId || busy || actionLock.current) return;
    actionLock.current = true; setAction('update'); setUpdateError('');
    setUpdates(current => current ? { ...current, completed: 0, total: pendingUpdate.length } : current);
    try {
      const result = await request<OperationResult>('/skills/update', 'POST', { skillIds: pendingUpdate.map(skill => skill.id), scanId: updates.scanId, confirmed: true });
      setUpdates(result.updates); onState(result.state);
      if (result.success) { setPendingUpdate(null); onNotice(`已更新 ${pendingUpdate.length} 个 Skill。`); }
      else { const failed = result.results?.filter(item => !item.success).length ?? pendingUpdate.length; setPendingUpdate(null); onError(`${failed} 个 Skill 未能更新，请重新扫描后重试。`); }
    } catch (caught) { setUpdateError(operationError(caught, '更新失败，请重新扫描后重试。')); }
    finally { actionLock.current = false; setAction(null); }
  }

  const toolbar = <>
    <ShelfButton size="sm" variant="outline" disabled={busy || !state} onClick={() => void requestScan()}><RefreshCw className={action === 'scan' || updates?.scanning ? 'spin' : ''} />{action === 'scan' || updates?.scanning ? '正在扫描…' : '扫描更新'}</ShelfButton>
    <ShelfButton size="sm" variant="outline" disabled={!state || busy || counts['update-available'] === 0 || scanState !== 'fresh'} onClick={() => void requestUpdate()}>{action === 'update' ? <LoaderCircle className="spin" /> : <CircleArrowUp />}{action === 'update' ? updates?.total ? `正在更新 ${updates.completed}/${updates.total}` : '正在检查…' : scanState === 'missing' ? '扫描后更新' : scanState === 'stale' ? '重新扫描后更新' : `更新 ${counts['update-available']} 个`}</ShelfButton>
  </>;
  const legend = <div className="skill-update-legend" aria-label="Skill 更新状态">{statuses.map(status => {
    const Glyph = glyphs[status];
    return <button type="button" key={status} className="skill-update-legend-item" data-status={status} aria-pressed={filterStatus === status} title={labels[status]} onClick={() => setFilterStatus(current => current === status ? null : status)}><Glyph /><span>{labels[status]}</span><strong>{counts[status]}</strong></button>;
  })}</div>;
  const dialogs = <>
    {pendingUpdate && <OperationDialog className="skill-update-dialog" title="更新 Skill" description="更新会替换所选 Skill 的安装文件，请确认后继续。" locked={action === 'update'} onClose={() => setPendingUpdate(null)}>
      <ul className="skill-update-list">{pendingUpdate.map(skill => <li key={skill.id}><strong>{skill.name}</strong><small>{skill.scopeId === 'global' ? '全局' : state?.projects.find(project => `project:${project.id}` === skill.scopeId)?.name ?? '项目'}</small></li>)}</ul>
      {updateError && <p className="skill-update-error" role="alert">{updateError}</p>}
      <footer className="skill-operation-footer"><ShelfButton variant="outline" disabled={action === 'update'} onClick={() => setPendingUpdate(null)}>取消</ShelfButton><ShelfButton disabled={action === 'update'} onClick={() => void confirmUpdate()}>{action === 'update' && <LoaderCircle className="spin" />}{action === 'update' ? '正在更新…' : `更新 ${pendingUpdate.length} 个`}</ShelfButton></footer>
    </OperationDialog>}
  </>;
  return { toolbar, legend, dialogs, filterStatus, matchingIds, requestScan, requestUpdate, updates, busy, action, updatingSkillIds: action === 'update' ? pendingUpdate?.map(skill => skill.id) ?? [] : [] };
}

function OperationDialog({ title, description, locked, onClose, className, children }: { title: string; description: string; locked: boolean; onClose: () => void; className: string; children: ReactNode }) {
  const descriptionId = useId();
  return <ShelfDialog className={`skill-operation-dialog ${className}`} locked={locked} onClose={onClose} aria-describedby={descriptionId}>
    <header className="skill-operation-header" data-slot="dialog-header"><div><DialogTitle data-slot="dialog-title">{title}</DialogTitle><DialogDescription id={descriptionId} data-slot="dialog-description">{description}</DialogDescription></div></header>{children}
  </ShelfDialog>;
}
