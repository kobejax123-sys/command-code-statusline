// Local stand-in for the types that ship with the Command Code harness.
// @commandcode/harness is not published to npm and the mod is loaded from source,
// so this keeps `tsc --noEmit` usable. It declares only what statusline.ts
// touches and is not authoritative — treat it as a guard against typos and
// internal inconsistencies, not as the real API contract.

declare module '@commandcode/harness' {
	export interface ExecResult {
		code: number;
		stdout: string;
		stderr: string;
	}

	export interface ExecOptions {
		command: string;
		args?: string[];
		cwd?: string;
	}

	export interface FlagSpec {
		type: string;
		default: string;
		description: string;
	}

	export interface UiApi {
		capabilities: {status: boolean};
		setStatus(text: string | null): void;
		notify(message: string): void;
	}

	export interface CommandSpec {
		name: string;
		description: string;
		argumentHint?: string;
		handler: (input: {args?: string}) => {message: string} | void;
	}

	export interface ModApi {
		cwd: string;
		ui: UiApi;
		exec(options: ExecOptions): Promise<ExecResult>;
		addFlag(name: string, spec: FlagSpec): void;
		getFlag(name: string): unknown;
		on(event: string, handler: (event: any) => void): void;
		hooks(hooks: Record<string, (event: any, ctx: any) => void>): void;
		addCommand(spec: CommandSpec): void;
	}
}
