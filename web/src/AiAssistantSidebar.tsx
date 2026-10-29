import ShelfButton from './ShelfButton';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, FileSearch, History, Languages, LoaderCircle, RotateCcw, Save, Send, Settings, ShieldCheck, Sparkles, Square, SquarePen, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { request } from './api';
import ShelfSelect from './ShelfSelect';
import { aiLanguages, resolveAiModel, useAiPreferences, type AiStatus } from './ai-preferences';
import type { AiAnnotation, AiDraft, Skill } from './types';

type HistoryMessage = { role: 'user' | 'assistant'; content: string };
type ChatInput = { prompt: string; history: HistoryMessage[]; model: string; language: string; skillId?: string };
type Job = { id: string; status: 'running' | 'completed' | 'failed' | 'stopped'; content: string; model: string; contextFiles: string[]; error?: string };
type ConversationSummary = { id: string; title: string; preview: string; updatedAt: string; skillId?: string };
type Conversation = ConversationSummary & { messages: HistoryMessage[] };
type Message = HistoryMessage & { id: string; result?: Job; draft?: AiDraft; saved?: boolean; stopped?: boolean };
export type AiAssistantSidebarProps = {
  skill: Skill | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onClearSkillContext: () => void;
  onRestoreSkillContext?: (id: string | null) => void;
  onSaved?: (annotation: AiAnnotation) => void;
};
const id = () => crypto.randomUUID();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const historyOf = (messages: Message[]): HistoryMessage[] => messages.filter(message => message.content.trim()).map(({ role, content }) => ({ role, content }));
const wait = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

export default function AiAssistantSidebar({ skill, onClose, onOpenSettings, onClearSkillContext, onRestoreSkillContext, onSaved }: AiAssistantSidebarProps) {
  const preferences = useAiPreferences();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState(preferences.targetLanguage);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string>(id);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [running, setRunning] = useState<'chat' | 'summary' | 'translation' | null>(null);
  const [error, setError] = useState('');
  const [retryInput, setRetryInput] = useState<ChatInput | null>(null);
  const [savedNotice, setSavedNotice] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const active = useRef<{ type: 'chat' | 'quick'; jobId?: string; stop: boolean; controller: AbortController } | null>(null);
  const retryMessages = useRef<Message[]>([]);
  const requestLock = useRef(false);
  const available = preferences.enabled && Boolean(status?.available);
  const chosenModel = model || preferences.chatModel || status?.models[0]?.id || '';
  const analysisModel = resolveAiModel(preferences.summaryModel, status?.models || []);
  const writingModel = resolveAiModel(preferences.translationModel, status?.models || []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.stop = true;
        pending.controller.abort();
        if (pending.jobId) void request('/ai/chat/stop', 'POST', { id: pending.jobId }).catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void request<AiStatus>('/ai/status').then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setError(messageOf(error)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reload]);
  useEffect(() => {
    let current = true;
    void request<ConversationSummary[]>('/ai/conversations').then(value => { if (current) setHistory(value); })
      .catch(error => { if (current) setError(messageOf(error)); }).finally(() => { if (current) setHistoryLoading(false); });
    return () => { current = false; };
  }, []);
  useEffect(() => { setLanguage(preferences.targetLanguage); }, [preferences.targetLanguage]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: running ? 'auto' : 'smooth' }); }, [messages, running, error]);

  async function persist(next: Message[], contextId: string | undefined, currentConversationId = conversationId) {
    if (!next.length || !mounted.current) return;
    try {
      const summary = await request<ConversationSummary>('/ai/conversations', 'POST', { id: currentConversationId,
        messages: historyOf(next).slice(-100), ...(contextId ? { skillId: contextId } : {}) });
      if (mounted.current) setHistory(current => [summary, ...current.filter(item => item.id !== summary.id)]);
    } catch (error) { if (mounted.current) setError(messageOf(error)); }
  }

  function newConversation() {
    if (requestLock.current) return;
    setConversationId(id()); setMessages([]); setDraft(''); setError(''); setRetryInput(null); setSavedNotice('');
  }
  async function openConversation(conversation: ConversationSummary) {
    if (requestLock.current || conversation.id === conversationId) return;
    try {
      const value = await request<Conversation | null>(`/ai/conversations?id=${encodeURIComponent(conversation.id)}`);
      if (!value || !mounted.current) return;
      setConversationId(value.id); setMessages(value.messages.map(message => ({ ...message, id: id() })));
      setDraft(''); setError(''); setRetryInput(null); setSavedNotice(''); onRestoreSkillContext?.(value.skillId || null);
    } catch (error) { setError(messageOf(error)); }
  }
  async function deleteConversation() {
    if (requestLock.current || !messages.length) return;
    try {
      await request(`/ai/conversations/${encodeURIComponent(conversationId)}`, 'DELETE');
      setHistory(current => current.filter(item => item.id !== conversationId)); newConversation();
    } catch (error) { setError(messageOf(error)); }
  }

  async function runChat(input: ChatInput, pending: Message[]) {
    if (requestLock.current) return;
    requestLock.current = true;
    const currentConversation = conversationId;
    const placeholderId = id();
    const controller = new AbortController();
    const operation = { type: 'chat' as const, jobId: undefined as string | undefined, stop: false, controller };
    active.current = operation;
    setMessages([...pending, { id: placeholderId, role: 'assistant', content: '' }]);
    setRunning('chat'); setError(''); setRetryInput(null); setSavedNotice('');
    let latest: Job | undefined;
    try {
      // Do not abort job creation: if the panel closes, its returned ID is immediately stopped.
      latest = await request<Job>('/ai/chat', 'POST', input);
      operation.jobId = latest.id;
      if (operation.stop || !mounted.current) latest = await request<Job>('/ai/chat/stop', 'POST', { id: latest.id });
      while (latest.status === 'running') {
        if (mounted.current) setMessages([...pending, { id: placeholderId, role: 'assistant', content: latest.content, result: latest }]);
        await wait(controller.signal);
        latest = await request<Job>(`/ai/chat?id=${encodeURIComponent(latest.id)}`, 'GET', undefined, true, controller.signal);
      }
      const next = [...pending, ...(latest.content ? [{ id: placeholderId, role: 'assistant' as const, content: latest.content, result: latest, stopped: latest.status === 'stopped' }] : [])];
      if (mounted.current) {
        setMessages(next);
        if (latest.status === 'failed') { setError(latest.error || '模型未能完成回复，请重试。'); retryMessages.current = pending; setRetryInput(input); }
        else if (latest.status === 'stopped') setSavedNotice('已停止回复');
        await persist(next, input.skillId, currentConversation);
      }
    } catch (error) {
      if (!operation.stop && operation.jobId) void request('/ai/chat/stop', 'POST', { id: operation.jobId }).catch(() => {});
      if (mounted.current) {
        if (operation.stop && operation.jobId) {
          try { latest = await request<Job>(`/ai/chat?id=${encodeURIComponent(operation.jobId)}`); } catch { /* Keep the latest visible partial reply. */ }
        }
        const next = [...pending, ...(latest?.content ? [{ id: placeholderId, role: 'assistant' as const, content: latest.content, result: latest, stopped: operation.stop }] : [])];
        setMessages(next);
        if (operation.stop) setSavedNotice('已停止回复');
        else { setError(messageOf(error)); retryMessages.current = pending; setRetryInput(input); }
        await persist(next, input.skillId, currentConversation);
      }
    } finally {
      if (active.current === operation) active.current = null;
      requestLock.current = false;
      if (mounted.current) setRunning(null);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || !available || !chosenModel || requestLock.current) return;
    if (!status?.models.some(item => item.id === chosenModel)) { setError('所选模型未在 Magpie 中启用，请重新选择；不会自动切换模型。'); return; }
    const input: ChatInput = { prompt, history: historyOf(messages).slice(-20), model: chosenModel,
      language: preferences.targetLanguage, ...(skill ? { skillId: skill.id } : {}) };
    const next = [...messages, { id: id(), role: 'user' as const, content: prompt }];
    setDraft(''); await runChat(input, next);
  }
  async function stop() {
    const operation = active.current;
    if (!operation) return;
    operation.stop = true;
    if (operation.type === 'quick') { operation.controller.abort(); return; }
    if (!operation.jobId) return;
    try { await request('/ai/chat/stop', 'POST', { id: operation.jobId }); operation.controller.abort(); }
    catch (error) { if (mounted.current) setError(messageOf(error)); }
  }
  function retry() {
    if (!retryInput || requestLock.current) return;
    void runChat(retryInput, retryMessages.current);
  }
  async function quickAction(kind: 'summary' | 'translation' | 'analysis') {
    if (!skill || !available || requestLock.current) return;
    const label = kind === 'summary' ? '生成描述' : kind === 'translation' ? '翻译' : '分析 Skill';
    const pending = [...messages, { id: id(), role: 'user' as const, content: label }];
    if (kind === 'analysis') {
      if (!analysisModel) return;
      await runChat({ prompt: '请分析所选 Skill 的用途、使用条件、工作流程和注意事项。只依据附上的文档；没有提供的文件请说明无法确认。不要执行 Skill 或它的命令。',
        history: historyOf(messages).slice(-20), model: analysisModel, language: preferences.targetLanguage, skillId: skill.id }, pending);
      return;
    }
    const selected = writingModel;
    if (!selected) { setError('所选模型未在 Magpie 中启用，请在 AI 设置中重新选择。'); return; }
    requestLock.current = true;
    setMessages(pending); setRunning(kind); setError(''); setRetryInput(null); setSavedNotice('');
    const contextId = skill.id, currentConversation = conversationId;
    const operation = { type: 'quick' as const, stop: false, controller: new AbortController() };
    active.current = operation;
    try {
      const result = await request<AiDraft>('/ai/generate', 'POST', { skillId: contextId, kind, model: selected, language,
        ...(kind === 'summary' ? { summaryContext: preferences.summaryContext } : {}) }, true, operation.controller.signal);
      if (mounted.current) {
        const next = [...pending, { id: id(), role: 'assistant' as const, content: result.text, draft: result }];
        setMessages(next); await persist(next, contextId, currentConversation);
      }
    } catch (error) { if (mounted.current) { if (operation.stop) setSavedNotice('已停止回复'); else setError(messageOf(error)); await persist(pending, contextId, currentConversation); } }
    finally { if (active.current === operation) active.current = null; requestLock.current = false; if (mounted.current) setRunning(null); }
  }
  async function saveDescription(message: Message) {
    if (!message.draft || saving || requestLock.current) return;
    setSaving(message.id); setError('');
    try {
      const annotation = await request<AiAnnotation>('/ai/save', 'POST', { draftId: message.draft.draftId });
      setMessages(current => current.map(item => item.id === message.id ? { ...item, saved: true } : item));
      setSavedNotice('描述已保存在本地。'); onSaved?.(annotation);
    } catch (error) { setError(messageOf(error)); }
    finally { setSaving(null); }
  }
  const models = [
    ...(chosenModel && !status?.models.some(item => item.id === chosenModel) ? [{ value: chosenModel, label: `未启用：${chosenModel}`, disabled: true }] : []),
    ...(status?.models.map(item => ({ value: item.id, label: `${item.name || item.id} · Magpie` })) || []),
  ];

  return <section className="ai-assistant-sidebar" aria-label="Skill 助手" data-testid="ai-assistant-sidebar"><div className="ai-panel-layout">
    <header className="ai-panel-header"><div><span className="ai-panel-mark"><Sparkles /></span><div className="ai-panel-heading"><span>Skill 助手</span>
      <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button className="ai-history-trigger" type="button" disabled={Boolean(running)}><strong>{history.find(item => item.id === conversationId)?.title || skill?.name || '通用对话'}</strong><ChevronDown /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="start" sideOffset={8} collisionPadding={8} className="shelf-menu ai-history-menu"><DropdownMenu.Label className="ai-history-label"><History />对话历史</DropdownMenu.Label><div className="ai-history-list">
          {historyLoading ? <div className="ai-history-empty"><LoaderCircle className="spin" />加载中…</div> : !history.length ? <p className="ai-history-empty">还没有保存的对话</p> : history.map(item => <DropdownMenu.Item key={item.id} aria-current={item.id === conversationId ? 'page' : undefined} className="ai-history-item" onSelect={() => void openConversation(item)}><span><strong>{item.title}</strong><small>{item.preview}</small></span><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: '2-digit' })}</time></DropdownMenu.Item>)}
        </div></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    </div></div><div className="ai-panel-header-actions">
      <button className="ai-icon-button" aria-label="新建对话" title="新建对话" disabled={Boolean(running)} onClick={newConversation}><SquarePen /></button>
      <button className="ai-icon-button" aria-label="删除当前对话" title="删除当前对话" disabled={Boolean(running) || !messages.length} onClick={() => void deleteConversation()}><Trash2 /></button>
      <button className="ai-icon-button" aria-label="AI 设置" title="AI 设置" onClick={onOpenSettings}><Settings /></button>
      <button className="ai-icon-button" aria-label="关闭 AI 助手" title="关闭 AI 助手" onClick={onClose}><X /></button>
    </div></header>
    {loading ? <div className="ai-panel-loading"><LoaderCircle className="spin" />加载中…</div> : !available ? <div className="ai-panel-state"><span><Sparkles /></span><strong>连接模型后使用助手</strong><p>连接一次 AI 模型后，即可通用对话、分析 Skill、生成描述和翻译。</p>{status?.reason && <p role="status">{status.reason}</p>}<ShelfButton variant="default" size="sm" onClick={onOpenSettings}><Settings size={14} />配置模型服务</ShelfButton><button className="text-button" onClick={() => setReload(value => value + 1)}>重新连接</button></div> : <>
      <div className="ai-panel-scroll ai-chat-scroll" ref={scrollRef}>
        {!messages.length && <div className="ai-welcome"><span><Bot /></span><strong>想聊些什么？</strong><p>{skill ? `可以询问 ${skill.name} 的内容，也可以使用 Skill 操作来分析它的文件。` : '可以询问 Agent Skills、skills.sh、安装策略或本地工作流。'}</p></div>}
        {skill && <section className="ai-skill-tools"><header><span>Skill 操作</span><ShelfSelect aria-label="翻译为" value={language} onValueChange={setLanguage} disabled={Boolean(running)} options={aiLanguages.map(([value, label]) => ({ value, label }))} /></header><div>
          <ShelfButton variant="outline" size="sm" className="ai-button-xs" disabled={Boolean(running) || !writingModel} onClick={() => void quickAction('summary')}><Sparkles />生成描述</ShelfButton>
          <ShelfButton variant="outline" size="sm" className="ai-button-xs" disabled={Boolean(running) || !analysisModel} onClick={() => void quickAction('analysis')}><FileSearch />分析 Skill</ShelfButton>
          <ShelfButton variant="outline" size="sm" className="ai-button-xs" disabled={Boolean(running) || !writingModel || !skill.description.trim()} onClick={() => void quickAction('translation')}><Languages />翻译</ShelfButton>
        </div></section>}
        <div className="ai-message-list">{messages.filter(message => message.content.trim()).map(message => <article className={`ai-message is-${message.role}`} key={message.id}><header><span>{message.role === 'user' ? '你' : '助手'}</span>{message.draft && <ShelfButton variant="ghost" size="sm" className="ai-button-xs" disabled={message.saved || Boolean(saving) || Boolean(running)} onClick={() => void saveDescription(message)}>{saving === message.id ? <LoaderCircle className="spin" /> : <Save />}{message.saved ? '已保存' : '保存为描述'}</ShelfButton>}</header><div className="ai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span> }}>{message.content}</ReactMarkdown></div>{message.result && <details className="ai-context-details"><summary><ShieldCheck /><span>{message.result.contextFiles.length} 个文件 · Magpie / {message.result.model}</span></summary><div>{message.result.contextFiles.map(file => <code key={file}>{file}</code>)}</div></details>}{message.stopped && <p className="ai-stopped-note">已停止回复</p>}</article>)}
          {running && <div className="ai-typing" role="status"><LoaderCircle className="spin" /><span>{running === 'summary' ? '正在编写简洁的资料库描述…' : running === 'translation' ? '正在翻译当前描述…' : '正在思考…'}</span></div>}
          {error && <div className="ai-error-state" role="alert"><strong>{error}</strong><div>{retryInput && <ShelfButton variant="outline" size="sm" className="ai-button-xs" disabled={Boolean(running)} onClick={retry}><RotateCcw />重试</ShelfButton>}<ShelfButton variant="outline" size="sm" className="ai-button-xs" onClick={() => setError('')}>关闭</ShelfButton></div></div>}
          {savedNotice && <p className="ai-saved-notice" role="status">{savedNotice}</p>}
        </div>
      </div>
      <form className="ai-question-form" onSubmit={event => void send(event)}>
        {skill ? <div className="ai-context-chip"><span>目标 Skill</span><strong>{skill.name}</strong><button aria-label="移除 Skill 上下文" title="移除 Skill 上下文" onClick={onClearSkillContext} type="button" disabled={Boolean(running)}><X /></button></div> : <div className="ai-general-context"><Bot />通用对话 · 未附加本地文件</div>}
        <textarea aria-label="聊聊 Skill，或询问其他相关问题…" placeholder="聊聊 Skill，或询问其他相关问题…" disabled={Boolean(running)} maxLength={2000} rows={2} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="ai-question-footer"><ShelfSelect aria-label="对话模型" className="ai-composer-model-select" value={chosenModel} onValueChange={setModel} disabled={Boolean(running)} options={models} />
          {running ? <ShelfButton variant="default" size="sm" className="ai-icon-button" aria-label="停止回复" title="停止回复" type="button" onClick={() => void stop()}><Square /></ShelfButton> : <ShelfButton variant="default" size="sm" className="ai-icon-button" aria-label="提问" title="提问" type="submit" disabled={!draft.trim() || !chosenModel || !status?.models.some(item => item.id === chosenModel)}><Send /></ShelfButton>}
        </div>
      </form>
    </>}
  </div></section>;
}
