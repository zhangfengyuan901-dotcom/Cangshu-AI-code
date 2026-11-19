export type LocalChallengeState = { image: string; token: string; busy: boolean; error: boolean };
export function createLocalChallenge(options?: { fetchImpl?: typeof fetch; onChange?: (state: LocalChallengeState) => void; timeout?: number }): { load(): Promise<void>; verify(answer: string): Promise<void>; invalidate(): void; dispose(): void };
export function mountLocalChallenge(container: HTMLElement, onToken: (token: string) => void): { reset(): void; remove(): void };
