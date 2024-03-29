import * as jv from "jolievisualize";
import * as path from "path";
import * as vscode from "vscode";
import { addEdit, applyEditsAndSave } from "./edits";
import { deactivate, getVisFileURI, setIntercept } from "./extension";
import {
	createEmbed,
	createImportIfMissing,
	createPort,
} from "./operations/create";
import { removeEmbed, removePort } from "./operations/remove";
import { renamePort, renameService } from "./operations/rename";
import { createAggregator } from "./patterns/aggregator";
import { setVisfileContent } from "./visFile";

export default class WebPanel {
	static currentPanel: WebPanel | undefined;

	static readonly #viewtype = "jolievisualize";
	static data: string;
	static visFile: vscode.Uri;
	static visFileContent: string;
	readonly #panel: vscode.WebviewPanel;
	readonly #extensionPath: string;
	#disposables: vscode.Disposable[] = [];

	constructor(extensionPath: string, column: vscode.ViewColumn) {
		this.#extensionPath = extensionPath;

		this.#panel = vscode.window.createWebviewPanel(
			WebPanel.#viewtype,
			`Jolie Visualize`,
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(
						path.join(
							this.#extensionPath,
							"node_modules",
							"jolievisualize",
							"web"
						)
					),
				],
			}
		);
		this.#panel.webview.html = this.#getHTML();

		/**
		 * Listens for messages from the svelte UI
		 */
		this.#panel.webview.onDidReceiveMessage(async (msg: any) => {
			if (msg.command === "get.data") WebPanel.initData();
			if (msg.command === "reload") {
				WebPanel.initData();
				setIntercept(false);
			} else if (msg.command === "set.visfile") {
				setIntercept(true);
				await setVisfileContent(msg.detail);
			} else if (msg.command === "get.ranges")
				WebPanel.sendRange(await jv.getData(getVisFileURI(), false));
			else if (msg.command === "rename.port")
				addEdit(await renamePort(msg.detail));
			else if (msg.command === "remove.embed")
				addEdit(await removeEmbed(msg.detail));
			else if (msg.command === "create.embed") {
				addEdit(await createEmbed(msg.detail));
				addEdit(
					await createImportIfMissing(
						msg.detail.filename,
						msg.detail.embedFile,
						msg.detail.embedName,
						"service"
					)
				);
			} else if (msg.command === "remove.ports")
				for (const req of msg.detail.ports)
					addEdit(await removePort(req));
			else if (msg.command === "rename.service")
				addEdit(await renameService(msg.detail));
			else if (msg.command === "create.port") {
				addEdit(await createPort(msg.detail));
				for (const inf of msg.detail.port.interfaces) {
					addEdit(
						await createImportIfMissing(
							msg.detail.file,
							inf.file,
							inf.name,
							"interface"
						)
					);
				}
			} else if (msg.command === "create.pattern.aggregator") {
				const edits = await createAggregator(msg.detail);
				if (edits) edits.forEach((e) => addEdit(e));
			} else if (msg.command === "open.file") {
				const rootdir = path.dirname(getVisFileURI()?.fsPath ?? "");
				const doc = await vscode.workspace.openTextDocument(
					path.join(rootdir, msg.detail.file)
				);
				await vscode.window.showTextDocument(
					doc,
					vscode.ViewColumn.One
				);
			}

			if (msg.save) await applyEditsAndSave();
			if (msg.fromPopup) setIntercept(false);
		});

		this.#panel.onDidDispose(
			() => this.#dispose(),
			null,
			this.#disposables
		);
	}

	/**
	 * Sends visualization data to the UI and tells it to redraw everything
	 */
	static initData(): void {
		if (!WebPanel.currentPanel) return;
		WebPanel.currentPanel.#panel.webview.postMessage({
			command: "init.data",
			data: WebPanel.data,
		});
	}

	/**
	 * Sends visualization data to the UI
	 */
	static sendData(): void {
		if (!WebPanel.currentPanel) return;
		WebPanel.currentPanel.#panel.webview.postMessage({
			command: "set.data",
			data: WebPanel.data,
		});
	}

	/**
	 * Sends visualization data to the UI and updates all ranges.
	 * @param data visualize data containing new range information
	 */
	static sendRange(data: any): void {
		if (!WebPanel.currentPanel) return;
		WebPanel.currentPanel.#panel.webview.postMessage({
			command: "set.ranges",
			data,
		});
	}

	/**
	 * ! Not implemented
	 * Sends an undo request to the UI telling it to go to a previous state
	 */
	static undo(): void {
		if (!WebPanel.currentPanel) return;
		WebPanel.currentPanel.#panel.webview.postMessage({
			command: "undo",
		});
	}

	/**
	 * Open the webpanel in a vscode viewcolumn.
	 * @param extensionPath path to the extension in the filesystem
	 */
	static open(extensionPath: string): void {
		const column = vscode.ViewColumn.Beside;
		if (WebPanel.currentPanel) WebPanel.currentPanel.#panel.reveal(column);
		else WebPanel.currentPanel = new WebPanel(extensionPath, column);
	}

	/**
	 * Closes the webpanel and disposes of disposables
	 */
	static close(): void {
		if (!WebPanel.currentPanel) return;
		WebPanel.currentPanel.#dispose();
	}

	/**
	 * Adds the svelte JS and CSS paths into an HTML string.
	 * @returns HTML content to render in the webview
	 */
	#getHTML(): string {
		const scriptPathOnDisk = vscode.Uri.file(
			path.join(
				this.#extensionPath,
				"node_modules",
				"jolievisualize",
				"web",
				"bundle.js"
			)
		);
		const scriptUri = this.#panel.webview.asWebviewUri(scriptPathOnDisk);

		const stylePathOnDisk = vscode.Uri.file(
			path.join(
				this.#extensionPath,
				"node_modules",
				"jolievisualize",
				"web",
				"bundle.css"
			)
		);
		const styleUri = this.#panel.webview.asWebviewUri(stylePathOnDisk);

		const faviconPathOnDisk = vscode.Uri.file(
			path.join(
				this.#extensionPath,
				"node_modules",
				"jolievisualize",
				"web",
				"favicon.ico"
			)
		);
		this.#panel.iconPath = faviconPathOnDisk;

		const nonce = getNonce();
		return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
				<meta name="theme-color" content="#000000">
				<title>Jolie Visualize</title>
				<script defer src="https://d3js.org/d3.v7.min.js"></script>
				<script defer src="https://cdn.jsdelivr.net/npm/elkjs@0.8.2/lib/elk.bundled.min.js"></script>
				<link rel="stylesheet" type="text/css" href="${styleUri}">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
				<script defer nonce="${nonce}" src="${scriptUri}"></script>
			</head>
			<body style="overflow:hidden;">
				<noscript>You need to enable JavaScript to run this app.</noscript>
				<div id="app"></div>
			</body>
			</html>`;
	}

	/**
	 * Disposes all disposables and deactivates the extension.
	 */
	#dispose(): void {
		WebPanel.currentPanel = undefined;
		this.#panel.dispose();

		while (this.#disposables.length) {
			const x = this.#disposables.pop();
			if (x) x.dispose();
		}
		deactivate();
	}
}

/**
 * Generate a random nonce text
 * @returns Nonce string
 */
function getNonce(): string {
	let text = "";
	const possible =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
