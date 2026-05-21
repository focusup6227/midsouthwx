export type InviteSubscriberState =
  | { kind: 'idle' }
  | { kind: 'error'; error: string }
  | {
      kind: 'success';
      deeplink: string;
      expiresAt: string;
      displayName: string;
      email: string;
      emailStatus: 'sent' | 'unconfigured' | 'failed';
      emailError?: string;
    };

export const initialInviteState: InviteSubscriberState = { kind: 'idle' };
