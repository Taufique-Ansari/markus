import { createLogger, type UserInputQuestion, type UserInputAnswer } from '@markus/shared';
import type { OrganizationService } from './org-service.js';

const log = createLogger('hitl');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationType =
  | 'approval_request'
  | 'task_created'
  | 'task_completed'
  | 'task_review'
  | 'task_failed'
  | 'requirement_created'
  | 'requirement_decision'
  | 'agent_report'
  | 'direct_message'
  | 'group_message'
  | 'system';

export type NotificationActionType = 'none' | 'navigate' | 'open_chat';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  type: 'action' | 'expense' | 'access' | 'deployment' | 'custom';
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  expiresAt?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  allowFreeform?: boolean;
  selectedOption?: string;
  /** One or more structured questions (request_user_input). When present, the UI renders a multi-question form. */
  questions?: UserInputQuestion[];
  /** Aggregated answers to `questions`, filled on response. */
  answers?: UserInputAnswer[];
  /** When set, only these users (plus admins/owners) see and may respond to the approval in the API. */
  approverUserIds?: string[];
  /** The intended recipient; used for visibility filtering when approverUserIds is not set. */
  targetUserId?: string;
}


export interface Notification {
  id: string;
  targetUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority: NotificationPriority;
  read: boolean;
  actionType: NotificationActionType;
  actionTarget?: string;
  actionUrl?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRepo {
  insert(n: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): void;
  list(userId: string, opts?: { unreadOnly?: boolean; limit?: number; offset?: number; type?: string }): Array<{
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  count(userId: string, unreadOnly?: boolean): number;
  markRead(id: string): boolean;
  markAllRead(userId: string): number;
  /** Mark read all unread approval_request rows for an approval, across every user_id. */
  markReadByApprovalId?(approvalId: string): number;
  /** One-time self-heal for unread rows whose approval is no longer pending. */
  reconcileResolvedApprovalNotifications?(): number;
}

export interface ApprovalRepo {
  upsert(a: {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
  }): void;
  list(status?: string): Array<{
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
  }>;
  get(id: string): {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
  } | undefined;
}

type NotificationHandler = (notification: Notification) => void;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export class HITLService {
  private approvals = new Map<string, ApprovalRequest>();
  private pendingResolvers = new Map<
    string,
    (result: { approved: boolean; comment?: string; selectedOption?: string; answers?: UserInputAnswer[]; respondedBy?: string }) => void
  >();
  private notificationHandlers: NotificationHandler[] = [];
  /**
   * Channel-level consumers — the outbound gateway. Deliberately a **separate**
   * list from {@link notificationHandlers}: the two answer different questions.
   * "Who should see this in their bell" is per *person* (N emissions for
   * `targetUserId:'all'`); "one channel message per logical notification" is per
   * *channel* (exactly one). Sharing one list is the granularity confusion that
   * made a single notification reach a Feishu group N times (req_d25dc9b9).
   */
  private channelNotificationHandlers: NotificationHandler[] = [];
  /**
   * Approval-lifecycle consumers. A terminal transition (approved / rejected /
   * cancelled / expired) is a change to authoritative state that **every**
   * derived surface must observe — the in-app chat banner, the bell, any other
   * client. Deliberately separate from the notification streams: notifications
   * answer "tell this person", this one answers "the state changed".
   *
   * The emission lives at the transition itself (not at each call site) because
   * a decision can be written from ≥3 places — the HTTP API, the in-process
   * platform-action path, and the expiry timer. Wiring only the HTTP path is
   * exactly how the chat banner used to linger forever after an approval was
   * settled from Feishu (the resolving surface was not the one polling).
   */
  private approvalChangeHandlers: Array<(approval: ApprovalRequest) => void> = [];
  private notificationRepo?: NotificationRepo;
  private approvalRepo?: ApprovalRepo;
  private orgService?: OrganizationService;

  setOrgService(service: OrganizationService): void {
    this.orgService = service;
  }

  setNotificationRepo(repo: NotificationRepo): void {
    this.notificationRepo = repo;
    // One-time self-heal. Rows left unread by the old user-enumeration approach
    // (and approvals resolved before this fix) would otherwise advertise unread
    // notifications that the list hides — the "unread (1) over an empty list" bug.
    try {
      const healed = repo.reconcileResolvedApprovalNotifications?.() ?? 0;
      if (healed > 0) log.info(`Reconciled ${healed} stale unread approval notification(s)`);
    } catch (err) {
      log.warn('Failed to reconcile stale approval notifications', { error: String(err) });
    }
  }

  setApprovalRepo(repo: ApprovalRepo): void {
    this.approvalRepo = repo;
    // Restore persisted approvals into memory on startup
    try {
      const rows = repo.list();
      for (const row of rows) {
        if (!this.approvals.has(row.id)) {
          this.approvals.set(row.id, {
            id: row.id,
            agentId: row.agentId,
            agentName: row.agentName,
            type: row.type as ApprovalRequest['type'],
            title: row.title,
            description: row.description,
            details: row.details,
            status: row.status as ApprovalStatus,
            requestedAt: row.requestedAt,
            respondedAt: row.respondedAt,
            respondedBy: row.respondedBy,
            responseComment: row.responseComment,
            expiresAt: row.expiresAt,
            options: row.options,
            allowFreeform: row.allowFreeform,
            selectedOption: row.selectedOption,
            questions: row.questions,
            answers: row.answers,
            approverUserIds: row.approverUserIds,
            targetUserId: row.targetUserId,
          });
        }
      }
      log.info(`Restored ${rows.length} approvals from storage`);
    } catch (err) {
      log.warn('Failed to restore approvals from storage', { error: String(err) });
    }
  }

  /**
   * Per-person stream. Fires **once per human recipient** — `targetUserId:'all'`
   * fans out to N emissions by design (the in-app bell / WS push is per person).
   * Consumers that address a concrete user subscribe here.
   */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const idx = this.notificationHandlers.indexOf(handler);
      if (idx >= 0) this.notificationHandlers.splice(idx, 1);
    };
  }

  /**
   * Channel-level stream — the single granularity the outbound gateway needs:
   * fires **exactly once per `notify()` call**, no matter how many humans the
   * notification fans out to. This is what structurally guarantees "one logical
   * notification ⇒ one channel message", instead of leaving the dispatcher to
   * de-duplicate N per-person emissions (req_d25dc9b9).
   */
  onChannelNotification(handler: NotificationHandler): () => void {
    this.channelNotificationHandlers.push(handler);
    return () => {
      const idx = this.channelNotificationHandlers.indexOf(handler);
      if (idx >= 0) this.channelNotificationHandlers.splice(idx, 1);
    };
  }

  /**
   * Approval-lifecycle stream. Fires exactly once per terminal transition,
   * whichever surface caused it (in-app modal, Feishu card tap, expiry timer).
   * Consumers invalidate their derived views from this — that is what makes an
   * approval decided in an external IM disappear from the in-app banner too.
   */
  onApprovalChanged(handler: (approval: ApprovalRequest) => void): () => void {
    this.approvalChangeHandlers.push(handler);
    return () => {
      const idx = this.approvalChangeHandlers.indexOf(handler);
      if (idx >= 0) this.approvalChangeHandlers.splice(idx, 1);
    };
  }

  private emit(n: Notification): void {
    for (const h of this.notificationHandlers) {
      try { h(n); } catch { /* ignore */ }
    }
  }

  private emitChannel(n: Notification): void {
    for (const h of this.channelNotificationHandlers) {
      try { h(n); } catch { /* ignore */ }
    }
  }

  private emitApprovalChanged(approval: ApprovalRequest): void {
    for (const h of this.approvalChangeHandlers) {
      try { h(approval); } catch { /* ignore */ }
    }
  }

  requestApproval(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    questions?: UserInputQuestion[];
    approverUserIds?: string[];
  }): ApprovalRequest {
    const id = genId('apr');
    const now = new Date().toISOString();
    const approval: ApprovalRequest = {
      id,
      agentId: opts.agentId,
      agentName: opts.agentName,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      details: opts.details ?? {},
      status: 'pending',
      requestedAt: now,
      expiresAt: opts.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : undefined,
      options: opts.options,
      allowFreeform: opts.allowFreeform,
      questions: opts.questions,
      approverUserIds: opts.approverUserIds,
      targetUserId: opts.targetUserId,
    };
    this.approvals.set(id, approval);
    this.persistApproval(approval);
    log.info(`Approval requested: ${id} by ${opts.agentName}`);

    this.notify({
      targetUserId: opts.targetUserId ?? 'all',
      type: 'approval_request',
      title: opts.title,
      body: opts.description,
      priority: 'high',
      actionType: 'navigate',
      actionTarget: JSON.stringify({ path: `/approvals/${id}` }),
      // `agentId` travels with the notification so the outbound gateway can route
      // it to the producing agent's own channel before falling back to the global
      // default (G4, design §7.3).
      metadata: { approvalId: id, agentId: opts.agentId, options: opts.options },
    });

    return approval;
  }

  async requestApprovalAndWait(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    questions?: UserInputQuestion[];
    approverUserIds?: string[];
  }): Promise<{ approved: boolean; comment?: string; selectedOption?: string; answers?: UserInputAnswer[]; respondedBy?: string }> {
    const approval = this.requestApproval(opts);
    return new Promise<{ approved: boolean; comment?: string; selectedOption?: string; answers?: UserInputAnswer[]; respondedBy?: string }>((resolve) => {
      this.pendingResolvers.set(approval.id, resolve);
      if (opts.expiresInMs) {
        setTimeout(() => {
          if (this.pendingResolvers.has(approval.id)) {
            this.pendingResolvers.delete(approval.id);
            const a = this.approvals.get(approval.id);
            if (a && a.status === 'pending') {
              a.status = 'expired';
              a.respondedAt = new Date().toISOString();
              a.responseComment = 'Approval timed out';
              this.persistApproval(a);
              this.markApprovalNotificationsRead(a.id);
              this.emitApprovalChanged(a);
            }
            resolve({ approved: false, comment: 'Approval timed out' });
          }
        }, opts.expiresInMs);
      }
    });
  }

  respondToApproval(id: string, approved: boolean, respondedBy: string, comment?: string, selectedOption?: string, answers?: UserInputAnswer[]): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = approved ? 'approved' : 'rejected';
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = respondedBy;
    if (comment) approval.responseComment = comment;
    if (selectedOption) approval.selectedOption = selectedOption;
    if (answers && answers.length > 0) approval.answers = answers;
    this.persistApproval(approval);
    log.info(`Approval ${id} ${approval.status} by ${respondedBy}`, { comment, selectedOption, answerCount: answers?.length ?? 0 });

    this.markApprovalNotificationsRead(id);
    this.emitApprovalChanged(approval);

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({ approved, comment, selectedOption, answers, respondedBy });
    }
    return approval;
  }

  cancelApproval(id: string, cancelledBy: string, comment?: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = 'cancelled';
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = cancelledBy;
    if (comment) approval.responseComment = comment;
    this.persistApproval(approval);
    log.info(`Approval ${id} cancelled by ${cancelledBy}`, { comment });

    this.markApprovalNotificationsRead(id);
    this.emitApprovalChanged(approval);

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({ approved: false, comment: comment ?? 'Approval cancelled' });
    }
    return approval;
  }

  cancelApprovalsByDetail(key: string, value: unknown, cancelledBy: string, comment?: string): number {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.status === 'pending' && approval.details[key] === value) {
        this.cancelApproval(approval.id, cancelledBy, comment);
        count++;
      }
    }
    return count;
  }

  private persistApproval(approval: ApprovalRequest): void {
    if (!this.approvalRepo) return;
    try {
      this.approvalRepo.upsert({
        id: approval.id,
        agentId: approval.agentId,
        agentName: approval.agentName,
        type: approval.type,
        title: approval.title,
        description: approval.description,
        details: approval.details,
        status: approval.status,
        requestedAt: approval.requestedAt,
        respondedAt: approval.respondedAt,
        respondedBy: approval.respondedBy,
        responseComment: approval.responseComment,
        expiresAt: approval.expiresAt,
        options: approval.options,
        allowFreeform: approval.allowFreeform,
        selectedOption: approval.selectedOption,
        questions: approval.questions,
        answers: approval.answers,
        approverUserIds: approval.approverUserIds,
        targetUserId: approval.targetUserId,
      });
    } catch (err) {
      log.warn('Failed to persist approval', { id: approval.id, error: String(err) });
    }
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    return status ? all.filter(a => a.status === status) : all;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  listNotifications(userId?: string, unreadOnly = false, opts?: { limit?: number; offset?: number; type?: string }): Notification[] {
    if (this.notificationRepo && userId) {
      const rows = this.notificationRepo.list(userId, {
        unreadOnly,
        limit: opts?.limit,
        offset: opts?.offset,
        type: opts?.type,
      });
      return rows.map(r => this.rowToNotification(r));
    }
    return [];
  }

  countNotifications(userId: string, unreadOnly = false): { total: number; unread: number } {
    if (this.notificationRepo) {
      return {
        total: this.notificationRepo.count(userId, false),
        unread: this.notificationRepo.count(userId, true),
      };
    }
    return { total: 0, unread: 0 };
  }

  markNotificationRead(id: string): boolean {
    if (this.notificationRepo) {
      return this.notificationRepo.markRead(id);
    }
    return false;
  }

  markAllNotificationsRead(userId: string): number {
    if (this.notificationRepo) {
      return this.notificationRepo.markAllRead(userId);
    }
    return 0;
  }

  notify(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    let targetUserIds: string[];
    if (opts.targetUserId === 'all') {
      if (this.orgService) {
        const humans = this.orgService.listHumanUsers('default');
        targetUserIds = humans.map(h => h.id);
        if (targetUserIds.length === 0) targetUserIds = ['all'];
      } else {
        targetUserIds = ['all'];
      }
    } else {
      targetUserIds = [opts.targetUserId];
    }

    let first: Notification | undefined;
    for (const targetUserId of targetUserIds) {
      const n = this.notifySingle({ ...opts, targetUserId });
      first ??= n;
    }

    // Channel-level stream: exactly ONE logical event per notify() call, for
    // consumers that address a *channel* rather than a person (the outbound
    // gateway). Emitted from the single source, so it is independent of the
    // per-person fan-out above (req_d25dc9b9).
    this.emitChannel(this.buildNotification({ ...opts }));

    return first!;
  }

  /**
   * Assemble the notification shape — the **single** place the fields are built,
   * shared by the persisted per-person row and the logical channel event.
   */
  private buildNotification(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    return {
      id: genId('ntf'),
      targetUserId: opts.targetUserId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      priority: opts.priority ?? 'normal',
      read: false,
      actionType: opts.actionType ?? 'none',
      actionTarget: opts.actionTarget,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
  }

  private notifySingle(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    const notification = this.buildNotification(opts);

    if (this.notificationRepo) {
      try {
        this.notificationRepo.insert({
          id: notification.id,
          userId: notification.targetUserId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          priority: notification.priority,
          read: false,
          actionType: notification.actionType,
          actionTarget: notification.actionTarget ?? null,
          metadata: notification.metadata ?? null,
          createdAt: notification.createdAt,
        });
      } catch (err) {
        log.warn('Failed to persist notification', { error: String(err) });
      }
    }

    this.emit(notification);
    return notification;
  }

  /** Mark unread approval_request rows for this approval read, across every user_id. */
  private markApprovalNotificationsRead(approvalId: string): void {
    if (!this.notificationRepo) return;

    // Preferred path: key straight on metadata.approvalId — exact, unbounded, and
    // it cannot miss a user_id we forgot to enumerate.
    if (this.notificationRepo.markReadByApprovalId) {
      try {
        this.notificationRepo.markReadByApprovalId(approvalId);
        return;
      } catch (err) {
        log.warn('Failed to mark approval notifications read by approvalId', {
          approvalId, error: String(err),
        });
      }
    }

    // Fallback for repos without the keyed update. NOTE: this can miss rows sent
    // to user_ids outside the enumerated set and is capped at 200 rows per user —
    // exactly the gap the keyed path above closes.
    const userIds = new Set<string>(['all']);
    if (this.orgService) {
      for (const h of this.orgService.listHumanUsers('default')) {
        userIds.add(h.id);
      }
    }
    for (const userId of userIds) {
      try {
        const rows = this.notificationRepo.list(userId, { type: 'approval_request', limit: 200 });
        for (const row of rows) {
          if (row.metadata && (row.metadata as Record<string, unknown>).approvalId === approvalId && !row.read) {
            this.notificationRepo.markRead(row.id);
          }
        }
      } catch { /* best effort */ }
    }
  }

  private rowToNotification(r: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): Notification {
    return {
      id: r.id,
      targetUserId: r.userId,
      type: r.type as NotificationType,
      title: r.title,
      body: r.body,
      priority: r.priority as NotificationPriority,
      read: r.read,
      actionType: r.actionType as NotificationActionType,
      actionTarget: r.actionTarget ?? undefined,
      createdAt: r.createdAt,
      metadata: r.metadata ?? undefined,
    };
  }
}
