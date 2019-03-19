import { ForkOptions, ChildProcess } from "child_process";
import { mkdirp } from "fs-extra";
import * as os from "os";
import { logger, field } from "@coder/logger";
import { Pong, ServerMessage, ClientMessage, WorkingInitMessage, MethodMessage, SuccessMessage, FailMessage, EventMessage } from "../proto";
import { ReadWriteConnection } from "../common/connection";
import { ServerProxy } from "../common/proxy";
import { stringify, parse, } from "../common/util";
import { Fs } from "./modules";

// `any` is needed to deal with sending and receiving arguments of any type.
// tslint:disable no-any

export type ForkProvider = (modulePath: string, args: string[], options: ForkOptions) => ChildProcess;

export interface ServerOptions {
	readonly workingDirectory: string;
	readonly dataDirectory: string;
	readonly cacheDirectory: string;
	readonly builtInExtensionsDirectory: string;
	readonly fork?: ForkProvider;
}

export class Server {
	private readonly proxies = new Map<number | string, any>();

	public constructor(
		private readonly connection: ReadWriteConnection,
		private readonly options?: ServerOptions,
	) {
		connection.onMessage(async (data) => {
			try {
				await this.handleMessage(ClientMessage.deserializeBinary(data));
			} catch (ex) {
				logger.error(
					"Failed to handle client message",
					field("length", data.byteLength),
					field("exception", {
						message: ex.message,
						stack: ex.stack,
					}),
				);
			}
		});

		connection.onClose(() => {
			this.proxies.forEach((p) => p.dispose && p.dispose());
			this.proxies.clear();
		});

		this.proxies.set("fs", new Fs());

		if (!this.options) {
			logger.warn("No server options provided. InitMessage will not be sent.");

			return;
		}

		Promise.all([
			mkdirp(this.options.cacheDirectory),
			mkdirp(this.options.dataDirectory),
			mkdirp(this.options.workingDirectory),
		]).catch((error) => {
			logger.error(error.message, field("error", error));
		});

		const initMsg = new WorkingInitMessage();
		initMsg.setDataDirectory(this.options.dataDirectory);
		initMsg.setWorkingDirectory(this.options.workingDirectory);
		initMsg.setBuiltinExtensionsDir(this.options.builtInExtensionsDirectory);
		initMsg.setHomeDirectory(os.homedir());
		initMsg.setTmpDirectory(os.tmpdir());
		const platform = os.platform();
		let operatingSystem: WorkingInitMessage.OperatingSystem;
		switch (platform) {
			case "win32":
				operatingSystem = WorkingInitMessage.OperatingSystem.WINDOWS;
				break;
			case "linux":
				operatingSystem = WorkingInitMessage.OperatingSystem.LINUX;
				break;
			case "darwin":
				operatingSystem = WorkingInitMessage.OperatingSystem.MAC;
				break;
			default:
				throw new Error(`unrecognized platform "${platform}"`);
		}
		initMsg.setOperatingSystem(operatingSystem);
		initMsg.setShell(os.userInfo().shell || global.process.env.SHELL);
		const srvMsg = new ServerMessage();
		srvMsg.setInit(initMsg);
		connection.send(srvMsg.serializeBinary());
	}

	/**
	 * Handle all messages from the client.
	 */
	private async handleMessage(message: ClientMessage): Promise<void> {
		if (message.hasMethod()) {
			await this.runMethod(message.getMethod()!);
		} else if (message.hasPing()) {
			logger.trace("ping");
			const srvMsg = new ServerMessage();
			srvMsg.setPong(new Pong());
			this.connection.send(srvMsg.serializeBinary());
		} else {
			throw new Error("unknown message type");
		}
	}

	/**
	 * Run a method on a proxy.
	 */
	private async runMethod(message: MethodMessage): Promise<void> {
		const proxyMessage = message.getNamedProxy()! || message.getNumberedProxy()!;
		const id = proxyMessage.getId();
		const proxyId = message.hasNamedProxy()
			? message.getNamedProxy()!.getModule()
			: message.getNumberedProxy()!.getProxyId();
		const method = proxyMessage.getMethod();
		const args = proxyMessage.getArgsList().map(parse);

		logger.trace(() => [
			"received",
			field("id", id),
			field("proxyId", proxyId),
			field("method", method),
			field("args", args),
		]);

		try {
			const proxy = this.proxies.get(proxyId);

			if (typeof proxy[method] !== "function") {
				throw new Error(`"${method}" is not a function`);
			}

			let response = (proxy as any)[method](...args);

			// Proxies must always return promises or proxies since synchronous values
			// won't work due to the async nature of these messages. Proxies must be
			// returned synchronously so we can store them and attach callbacks
			// immediately (like "open" which won't work if attached too late). The
			// client creates its own proxies which is what allows this to work.
			if (this.isPromise(response)) {
				response = await response;
				if (this.isProxy(response)) {
					throw new Error(`"${method}" proxy must be returned synchronously`);
				}
			} else if (this.isProxy(response)) {
				this.proxies.set(id, response);
				response.onDidDispose(() => {
					this.proxies.delete(id);
					// The timeout is to let all the normal events fire first so the
					// client doesn't dispose its event emitter before they go through.
					setTimeout(() => this.sendEvent(id, "dispose"), 1);
				});
				response.onEvent((event, ...args: any[]) => {
					this.sendEvent(id, event, ...args);
				});
				// No need to send anything back since the client creates the proxy.
				response = undefined;
			} else {
				const error = new Error(`"${method} does not return a Promise or ServerProxy"`);
				logger.error(
					error.message,
					field("type", typeof response),
					field("proxyId", proxyId),
				);
				throw error;
			}
			this.sendResponse(id, response);
		} catch (error) {
			this.sendException(id, error);
		}
	}

	/**
	 * Send an event to the client.
	 */
	private sendEvent(id: number, event: string, ...args: any[]): void {
		const eventMessage = new EventMessage();
		eventMessage.setProxyId(id);
		eventMessage.setEvent(event);
		eventMessage.setArgsList(args.map(stringify));

		const serverMessage = new ServerMessage();
		serverMessage.setEvent(eventMessage);
		this.connection.send(serverMessage.serializeBinary());
	}

	/**
	 * Send a response back to the client.
	 */
	private sendResponse(id: number, response: any): void {
		logger.trace(() => [
			"sending resolve",
			field("id", id),
			field("response", stringify(response)),
		]);

		const successMessage = new SuccessMessage();
		successMessage.setId(id);
		// Sending functions from the server to the client is not needed, so the
		// the second argument isn't provided.
		successMessage.setResponse(stringify(response));

		const serverMessage = new ServerMessage();
		serverMessage.setSuccess(successMessage);
		this.connection.send(serverMessage.serializeBinary());
	}

	/**
	 * Send an exception back to the client.
	 */
	private sendException(id: number, error: Error): void {
		logger.trace(() => [
			"sending reject",
			field("id", id) ,
			field("response", stringify(error)),
		]);

		const failedMessage = new FailMessage();
		failedMessage.setId(id);
		failedMessage.setResponse(stringify(error));

		const serverMessage = new ServerMessage();
		serverMessage.setFail(failedMessage);
		this.connection.send(serverMessage.serializeBinary());
	}

	private isProxy(value: any): value is ServerProxy {
		return value && typeof value === "object" && typeof value.onEvent === "function";
	}

	private isPromise(value: any): value is Promise<any> {
		return typeof value.then === "function" && typeof value.catch === "function";
	}
}
