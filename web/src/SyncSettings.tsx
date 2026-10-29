import ShelfButton from './ShelfButton';
import ShelfDialog, { DialogTitle, DialogDescription } from './ShelfDialog';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Cloud, FileJson, Loader2, RefreshCw } from 'lucide-react';
import { embedded, request } from './api';
import { Input } from './ShelfForm';
import type { Snapshot } from './types';
import { t } from './desktop-ui';
import './sync-settings.css';

type Props = { busy: boolean; onSynced: (snapshot: Snapshot) => void; onNotice: (text: string) => void; onError: (text: string) => void };
type Connection = { url: string; username: string; hasPassword: boolean; passwordNeedsReentry: boolean };
type Resolution = 'local' | 'incoming';
export type Preview = {
  id: string; mode: 'import' | 'upload'; exportedAt: string; source?: { deviceName?: string };
  matched: number; skipped: number; added: number; changed: number;
  total?: number; unchanged?: number; localOnly?: number;
  packs?: { total: number; changed: number; matchedMembers: number };
  managedSkills?: { total: number; added: number; updated: number; unchanged: number };
  conflicts: { id: string; skillName: string; field: string; local: string; incoming: string }[]; warnings: string[];
};
type ApplyResult = { snapshot?: Snapshot; uploaded?: boolean; cloudBackupSaved?: boolean };
const maxFileBytes = 100 * 1024 * 1024;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const outdatedBackend = (error: unknown) => ['Unknown workbench operation.', 'Skill Shelf sync is not running.'].includes(errorMessage(error));
function syncError(error: unknown) {
  const text = errorMessage(error);
  if (/preview (?:has expired|is stale)|snapshot changed|account changed|connection changed/i.test(text)) return '数据已变化，请关闭预览后重新读取。';
  if (/WebDAV (?:network error|timeout)/i.test(text)) return '无法连接 WebDAV，请检查网络和服务器地址后重试。';
  if (/WebDAV HTTP (?:401|403)/i.test(text)) return 'WebDAV 账号或密码不正确，或没有访问权限。';
  if (/WebDAV.*HTTP (?:409|412)/i.test(text)) return '云端数据已变化，请重新读取后再同步。';
  if (/WebDAV.*HTTP/i.test(text)) return 'WebDAV 服务暂不可用，请稍后重试。';
  if (/password required|credentials unavailable/i.test(text)) return '请重新输入 WebDAV 密码并保存。';
  if (/Invalid sync WebDAV URL/i.test(text)) return '服务器地址无效，请填写完整的 WebDAV 地址。';
  if (/requires an ETag/i.test(text)) return '此 WebDAV 服务不支持安全合并，暂不能上传。';
  if (/Cloud has no shared sync snapshot|WebDAV has no data/i.test(text)) return '云端还没有同步数据，请先从一台设备上传。';
  if (/encrypted legacy snapshot/i.test(text)) return '请先在客户端同步一次，再从插件上传。';
  if (/Invalid sync (?:JSON )?document|Not a Skill Shelf metadata sync document/i.test(text)) return '同步文件无效，请重新导出后再试。';
  return text;
}
const fieldLabel = (field: string) => field.startsWith('translation:') ? `翻译 · ${field.slice(12)}` : field.startsWith('description:') ? `描述 · ${field.slice(12)}` : ({ tags: '标签', folder: '分组层级', folderPath: '分组层级', files: '文件内容', name: '名称', description: '说明', color: '颜色', sort: '排序', viewOptions: '视图设置', language: '界面语言', theme: '主题', density: '界面密度', libraryViewMode: '默认视图', defaultAgents: '默认安装 Agent', focusedAgents: '关注 Agent', sidebarCollapsed: '侧栏收起状态' }[field] || '内容');
const colorLabel = (color: unknown) => ({ '#ed6a4a': '橙色', '#cb8b24': '黄色', '#358b68': '绿色', '#3e77c7': '蓝色', '#8a63a8': '紫色', '#767672': '灰色' }[String(color)] || String(color));

function conflictValue(field: string, raw: string) {
  if (field === 'files') return '文件内容有变化';
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* Older previews can contain plain text. */ }
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '空';
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' && item !== null && 'name' in item ? `${String(item.name)}${'color' in item && item.color ? `（${colorLabel(item.color)}）` : ''}` : String(item)).join(field === 'tags' ? '、' : ' / ');
  if (typeof value === 'object') return field === 'viewOptions' ? JSON.stringify(value, null, 2) : '内容有变化';
  if (field === 'color') return colorLabel(value);
  return String(value);
}

function ConflictValue({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const node = ref.current!;
    const measure = () => setScrollable(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <p ref={ref} role={scrollable ? 'region' : undefined} tabIndex={scrollable ? 0 : undefined} aria-label={scrollable ? label : undefined} onKeyDown={event => {
    if (!scrollable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const node = event.currentTarget;
    const steps: Record<string, number> = { ArrowDown: 32, ArrowUp: -32, PageDown: node.clientHeight, PageUp: -node.clientHeight };
    if (event.key in steps) { event.preventDefault(); node.scrollTop += steps[event.key]; }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); node.scrollTop = event.key === 'Home' ? 0 : node.scrollHeight; }
  }}>{text}</p>;
}

export function SyncPreviewDialog({ preview, origin, resolutions, unresolved, working, error, returnFocus, onClose, onChoose, onChooseAll, onApply }: {
  preview: Preview; origin: 'cloud' | 'file'; resolutions: Record<string, Resolution>; unresolved: number;
  working: boolean; error: string; returnFocus: HTMLElement | null; onClose: () => void;
  onChoose: (id: string, value: Resolution) => void; onChooseAll: (value: Resolution) => void; onApply: () => void;
}) {
  const timestamp = new Date(preview.exportedAt);
  return <ShelfDialog className="sync-preview-dialog" closeLabel="关闭同步预览" locked={working} onClose={onClose} returnFocus={returnFocus} aria-labelledby="sync-preview-title" aria-describedby="sync-preview-description" data-testid="sync-preview">
    <header data-slot="dialog-header"><DialogTitle id="sync-preview-title" data-slot="dialog-title">{preview.mode === 'upload' ? '上传预览' : '导入预览'}</DialogTitle><DialogDescription id="sync-preview-description" data-slot="dialog-description">合并匹配的已安装 Skill 整理信息，并导入 Packs 中保存的 Skill 文件及归属。文件有差异时先选择处理方式，确认后才会写入。</DialogDescription></header>
    <div className="sync-preview-scroll">
      <p className="sync-preview-source">上传来源：{preview.source?.deviceName || (origin === 'cloud' ? '云端' : '同步文件')}</p>
      <p className="sync-preview-date">数据导出时间：{Number.isNaN(timestamp.getTime()) ? '未知' : timestamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <div className="sync-preview-stats">{[['匹配的 Skill', preview.matched], ['有变更的 Skill', preview.changed], ['跳过的 Skill', preview.skipped], ['字段冲突', preview.conflicts.length]].map(([label, value]) => <span key={label}><strong>{value}</strong>{label}</span>)}</div>
      {preview.total !== undefined && <p className="sync-warning">包含 {preview.total} 个已安装 Skill 的整理信息；匹配、变更和跳过数量不包含 Packs 副本。</p>}
      {!!preview.packs?.total && <p className="sync-warning">包含 {preview.packs.total} 个 Pack，{preview.packs.changed} 个有变更，匹配 {preview.packs.matchedMembers} 个包内 Skill。</p>}
      {!!preview.managedSkills?.total && <p className="sync-warning">包含 {preview.managedSkills.total} 个 Packs Skill，新增 {preview.managedSkills.added} 个，更新 {preview.managedSkills.updated} 个。</p>}
      {!!preview.warnings.length && <div className="sync-warnings"><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {!!preview.conflicts.length && <section className="sync-conflicts" aria-label="内容冲突">
        <div className="sync-conflicts-heading"><h3>选择如何处理冲突</h3><div><ShelfButton variant="ghost" size="sm" type="button"  disabled={working} onClick={() => onChooseAll('local')}>全部保留本机</ShelfButton><ShelfButton variant="ghost" size="sm" type="button"  disabled={working} onClick={() => onChooseAll('incoming')}>全部采用导入数据</ShelfButton></div></div>
        {preview.conflicts.map(conflict => <div className="sync-conflict" key={conflict.id}>
          <strong>{conflict.skillName}<span>{fieldLabel(conflict.field)}</span></strong>
          <div className="sync-conflict-values">{(['local', 'incoming'] as const).map(side => <div key={side}><small>{side === 'local' ? '本机数据' : '文件／云端数据'}</small><ConflictValue text={conflictValue(conflict.field, conflict[side])} label={`${conflict.skillName} · ${fieldLabel(conflict.field)} · ${side === 'local' ? '本机数据' : '文件／云端数据'}`} /></div>)}</div>
          <select aria-label={`${conflict.skillName}：${fieldLabel(conflict.field)}的处理方式`} disabled={working} value={resolutions[conflict.id] || ''} onChange={event => onChoose(conflict.id, event.target.value as Resolution)}><option value="" disabled>请选择</option><option value="local">保留本机数据</option><option value="incoming">采用文件／云端数据</option></select>
        </div>)}
      </section>}
    </div>
    {error && <div className="sync-error sync-preview-error" role="alert">{error}</div>}
    <footer data-slot="dialog-footer"><ShelfButton variant="outline" size="default" type="button"  disabled={working} onClick={onClose}>取消</ShelfButton><ShelfButton variant="default" size="default" type="button"  disabled={working || !!unresolved} onClick={onApply}>{working ? <><Loader2 className="spin" size={16} />正在同步…</> : '确认合并'}</ShelfButton></footer>
  </ShelfDialog>;
}

export default function SyncSettings({ busy, onSynced, onNotice, onError }: Props) {
  const [saved, setSaved] = useState<Connection | null>(null);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [needsRestart, setNeedsRestart] = useState(false);
  const [connectionTested, setConnectionTested] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<'cloud' | 'file'>('cloud');
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const previewTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    setLoading(true); setError(''); setNeedsRestart(false);
    void request<Connection>('/sync/webdav', 'GET', undefined, true, abort.signal).then(next => {
      if (abort.signal.aborted) return;
      setSaved(next); setUrl(next.url); setUsername(next.username); setPassword('');
    }).catch(cause => {
      if (abort.signal.aborted) return;
      const restart = outdatedBackend(cause);
      setNeedsRestart(restart);
      setError(restart
        ? '请重新启动 Skill Shelf；在 Magpie 中可关闭后重新启用插件，然后点击「重新读取连接」。'
        : syncError(cause));
    })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, [revision]);

  const working = busy || loading || !!operation;
  const dirty = !!saved && (url !== saved.url || username !== saved.username || password !== '');
  const accountChanged = !!saved && (url.trim() !== saved.url || username !== saved.username);
  const ready = !!saved?.url && !dirty && !saved.passwordNeedsReentry;
  const unresolved = preview?.conflicts.filter(conflict => !resolutions[conflict.id]).length || 0;
  const clearPreview = () => { setPreview(null); setResolutions({}); };
  const changeConnection = (change: () => void) => { clearPreview(); setConnectionTested(false); setError(''); change(); };

  // The lock covers file reading too; stale requests cannot restore a cancelled/unmounted preview.
  const run = async (label: string, task: (signal: AbortSignal) => Promise<void>) => {
    if (lock.current || busy || loading) return;
    lock.current = true;
    const abort = new AbortController(); controller.current = abort;
    setOperation(label); setError('');
    try { await task(abort.signal); }
    catch (cause) { if (mounted.current && !abort.signal.aborted) { const text = syncError(cause); setError(text); onError(text); } }
    finally {
      lock.current = false;
      if (mounted.current && !abort.signal.aborted) setOperation('');
    }
  };
  const showPreview = (next: Preview, signal: AbortSignal) => {
    if (signal.aborted) return;
    setPreview(next); setResolutions({});
  };
  const save = () => void run('保存连接…', async signal => {
    clearPreview();
    const next = await request<Connection>('/sync/webdav', 'POST', { url: url.trim(), username, ...(password ? { password } : {}) }, true, signal);
    if (signal.aborted) return;
    setSaved(next); setUrl(next.url); setUsername(next.username); setPassword(''); setConnectionTested(false);
    onNotice(accountChanged && !password && saved?.hasPassword && !next.hasPassword
      ? 'WebDAV 连接已保存。账号已改变，旧密码已清除；请按需输入新账号密码。'
      : 'WebDAV 连接已保存。');
  });
  const testConnection = () => void run('测试连接…', async signal => {
    setConnectionTested(false);
    await request<{ connected: true }>('/sync/test', 'POST', {}, true, signal);
    if (signal.aborted) return;
    setConnectionTested(true); onNotice('WebDAV 连接正常。');
  });
  const cloudPreview = (mode: 'pull' | 'upload', trigger: HTMLElement) => {
    previewTrigger.current = trigger;
    setPreviewOrigin('cloud');
    void run(mode === 'pull' ? '下载并预览…' : '读取云端并预览合并…', async signal => {
      clearPreview();
      showPreview(await request<Preview>(`/sync/${mode}`, 'POST', {}, true, signal), signal);
    });
  };
  const importFile = (file: File | undefined) => {
    if (!file) return;
    setPreviewOrigin('file');
    void run('读取同步文件…', async signal => {
      clearPreview();
      if (file.size > maxFileBytes) throw new Error('同步文件不能超过 100 MiB。');
      let document: unknown;
      try { document = JSON.parse(await file.text()); }
      catch { throw new Error('无法读取同步文件，请选择有效的 JSON 文件。'); }
      signal.throwIfAborted();
      showPreview(await request<Preview>('/sync/preview', 'POST', { document }, true, signal), signal);
    });
  };
  const exportFile = () => void run('导出同步文件…', async signal => {
    if (embedded) {
      await request('/exports', 'POST', { type: 'sync' }, true, signal);
      onNotice('同步文件已保存，已打开导出文件夹。');
      return;
    }
    const document = await request<unknown>('/sync/export', 'GET', undefined, true, signal);
    if (signal.aborted) return;
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const link = window.document.createElement('a');
    link.href = blobUrl; link.download = 'skill-shelf.skill-shelf-sync.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    onNotice('同步文件已导出，不包含本机凭据。');
  });
  const apply = () => {
    if (!preview || unresolved || (preview.mode === 'upload' && !ready)) return;
    void run(preview.mode === 'upload' ? '合并并上传…' : '应用同步数据…', async signal => {
      const result = await request<ApplyResult>('/sync/apply', 'POST', { previewId: preview.id, resolutions }, true, signal);
      if (signal.aborted) return;
      if (result.snapshot) onSynced(result.snapshot);
      clearPreview();
      onNotice(result.uploaded
        ? `已合并并上传到云端。${result.cloudBackupSaved === true ? '已保存云端备份。' : result.cloudBackupSaved === false ? '提醒：未保存云端备份，请另行备份。' : ''}`
        : '同步数据已应用到本地。');
    });
  };

  return <div className="settings-page sync-settings" data-testid="settings-sync" aria-busy={working}>
    <header className="settings-page-header"><h2>{t('desktop.sync.title')}</h2></header>
    <p className="settings-page-description">{t('desktop.sync.description')}</p>
    <div className="sync-scope-note"><strong>{t('desktop.sync.scopeTitle')}</strong><p>同步 Packs 中的 Skill 及其文件、Pack 归属、包内分组、标签与排序，以及已安装 Skill 的整理信息、自定义描述和应用偏好。原始安装文件、部署记录和本机路径保留在各自电脑；Magpie 模型与账号凭据不参与同步。</p><p>已安装 Skill 按来源和名称匹配，项目 Skill 还会匹配项目名称。所有 Pack 中的 Skill 连同文件一起传输。</p></div>
    <section className="settings-section"><h3>导出／导入</h3><div className="setting-rows sync-method"><FileJson aria-hidden="true" /><div><strong>通过文件迁移</strong><p>在一台电脑导出，在另一台电脑导入并预览。包含 Packs 中全部 Skill 及其文件，以及匹配的已安装 Skill 整理信息。</p></div><div className="sync-actions">
      <ShelfButton variant="outline" size="sm" type="button"  disabled={working} onClick={exportFile}><ArrowUpFromLine />导出同步数据</ShelfButton><ShelfButton variant="outline" size="sm" type="button"  disabled={working || !!preview} onClick={event => { previewTrigger.current = event.currentTarget; fileInput.current?.click(); }}><ArrowDownToLine />导入同步数据</ShelfButton>
    </div></div><input ref={fileInput} className="sync-file-input" type="file" aria-label="同步 JSON 文件" accept=".json,application/json" disabled={working || !!preview} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); }} /></section>
    <section className="settings-section" aria-labelledby="sync-webdav-heading"><h3 id="sync-webdav-heading">WebDAV</h3><div className="setting-rows sync-webdav">
      <div className="sync-method-heading"><Cloud aria-hidden="true" /><div><strong>使用你的 WebDAV 存储</strong><p>上传时合并两端数据并保留备份，拉取时预览变更，确认后应用。</p></div></div>
      <form className="sync-webdav-form" aria-label="WebDAV 连接" onSubmit={event => { event.preventDefault(); if (dirty && url.trim() && !(saved?.passwordNeedsReentry && !accountChanged && !password)) save(); }}>
        <label className="sync-url-field"><span>WebDAV 服务地址</span><Input aria-label="WebDAV 服务地址" autoComplete="off" spellCheck={false} placeholder="https://dav.jianguoyun.com/dav/" value={url} disabled={working || !saved} onChange={event => changeConnection(() => setUrl(event.target.value))} /><small>两台电脑使用相同的服务地址和账号。应用会自动创建 SkillShelf 同步文件夹。坚果云填写 https://dav.jianguoyun.com/dav/，密码使用应用专用密码。</small></label>
        <label><span>用户名</span><Input aria-label="WebDAV 用户名" autoComplete="off" value={username} disabled={working || !saved} onChange={event => changeConnection(() => setUsername(event.target.value))} /></label>
        <label><span>密码／应用专用密码</span><Input aria-label="WebDAV 密码" aria-describedby="webdav-password-hint" type="password" autoComplete="new-password" placeholder={saved?.hasPassword && !accountChanged && !saved.passwordNeedsReentry ? '保留当前密码' : ''} value={password} disabled={working || !saved} onChange={event => changeConnection(() => setPassword(event.target.value))} /><small id="webdav-password-hint">{accountChanged ? '地址或账号已修改；留空将清除旧密码。' : saved?.passwordNeedsReentry ? '请重新输入一次 WebDAV 密码并保存连接。' : '保存连接后，密码会在本地保存，重启无需重新输入。'}</small></label>
        <div className="sync-actions sync-save-actions"><ShelfButton variant="default" size="sm" type="submit"  disabled={working || !dirty || !url.trim() || (!!saved?.passwordNeedsReentry && !accountChanged && !password)}>保存连接</ShelfButton><ShelfButton variant="ghost" size="sm" type="button"  disabled={working} onClick={() => { clearPreview(); setConnectionTested(false); setRevision(value => value + 1); }}><RefreshCw />重新读取连接</ShelfButton></div>
      </form>
      <div className="sync-webdav-actions"><ShelfButton variant="outline" size="sm" type="button"  disabled={working || !ready || !!preview} onClick={testConnection}><RefreshCw />测试连接</ShelfButton><ShelfButton variant="outline" size="sm" type="button"  disabled={working || !ready || !!preview} onClick={event => cloudPreview('upload', event.currentTarget)}><ArrowUpFromLine />上传数据</ShelfButton><ShelfButton variant="outline" size="sm" type="button"  disabled={working || !ready || !!preview} onClick={event => cloudPreview('pull', event.currentTarget)}><ArrowDownToLine />拉取数据</ShelfButton>{dirty ? <small>请先保存连接修改。</small> : connectionTested ? <small role="status">WebDAV 连接成功。</small> : loading ? <small>正在读取连接…</small> : needsRestart ? <small>请重新启动 Skill Shelf。</small> : saved?.passwordNeedsReentry ? <small>请重新输入密码并保存连接。</small> : null}</div>
    </div></section>
    {operation && <p className="sync-progress" role="status"><Loader2 className="spin" size={14} />{operation}</p>}
    {error && !preview && <div className="sync-error" role="alert">{error}</div>}
    {preview && <SyncPreviewDialog preview={preview} origin={previewOrigin} resolutions={resolutions} unresolved={unresolved} working={working} error={error} returnFocus={previewTrigger.current}
      onClose={() => { clearPreview(); setError(''); }} onChoose={(id, value) => setResolutions(current => ({ ...current, [id]: value }))}
      onChooseAll={value => setResolutions(Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, value])))} onApply={apply} />}
    <details className="sync-info"><summary>同步范围与隐私</summary><div>
      <p>同步 Packs 文件、文件夹、标签和排列位置，以及两端可匹配的已安装 Skills 的整理信息。下载时使用云端排列。</p>
      <p>原始 Skill 文件、部署记录、本机路径和 Magpie 账号不参与同步。同步需手动发起，不随 Magpie 同步。</p>
      <p>WebDAV 密码仅保存在本机，未加密。建议使用应用专用密码。客户端同步文件可能含有 AI 密钥，请使用可信的 WebDAV 服务。</p>
    </div></details>
  </div>;
}
