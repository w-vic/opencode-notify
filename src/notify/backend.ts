interface NotifyBackendOptions {
	preferCmux: boolean
	tryCmuxNotify: () => Promise<boolean>
	sendDesktopNotification: () => void | Promise<void>
}

export interface DesktopNotificationOptions {
	title: string
	message: string
	subtitle?: string
	sound?: string
	senderBundleId?: string | null
}

interface DesktopNotificationRouterOptions extends DesktopNotificationOptions {
	platform: NodeJS.Platform | string
	sendNodeNotifierNotification: () => void
	sendMacOSNotification?: (options: DesktopNotificationOptions) => Promise<boolean>
	sendWSLNotification?: (options: DesktopNotificationOptions) => Promise<boolean>
}

interface WSLNotificationRuntime {
	which?: (command: string) => string | null | Promise<string | null>
	spawnProcess?: (argv: string[]) => { exited: Promise<number> }
	warn?: (message: string) => void
}

export function isWSL(): boolean {
	return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/'/g, "''")
}

export async function sendWSLWindowsNotification(
	options: DesktopNotificationOptions,
	runtime: WSLNotificationRuntime = {},
): Promise<boolean> {
	const which = runtime.which ?? Bun.which
	const warn = runtime.warn ?? console.warn
	const spawnProcess =
		runtime.spawnProcess ??
		((argv: string[]) => Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }))

	try {
		const psPath = await which("powershell.exe")
		if (!psPath) {
			warn("notify: WSL Windows notification skipped; powershell.exe not found on PATH.")
			return false
		}

		const title = escapePowerShellSingleQuoted(options.title)
		const body = options.subtitle
			? `${escapePowerShellSingleQuoted(options.subtitle)} – ${escapePowerShellSingleQuoted(options.message)}`
			: escapePowerShellSingleQuoted(options.message)

		// Use WinRT ToastNotification API via PowerShell (no extra modules needed)
		const script = [
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
			"$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
			"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
			"$text = $xml.GetElementsByTagName('text')",
			`$text[0].AppendChild($xml.CreateTextNode('${title}')) | Out-Null`,
			`$text[1].AppendChild($xml.CreateTextNode('${body}')) | Out-Null`,
			"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
			"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenCode').Show($toast)",
		].join("; ")

		const proc = spawnProcess(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])
		const exitCode = await proc.exited

		if (exitCode === 0) return true

		warn(`notify: WSL Windows notification failed; powershell.exe exited with code ${exitCode}.`)
		return false
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warn(`notify: WSL Windows notification failed (${message}).`)
		return false
	}
}

interface AlerterProcess {
	exited: Promise<number>
}

interface AlerterRuntime {
	which?: (command: string) => string | null | Promise<string | null>
	spawnProcess?: (argv: string[]) => AlerterProcess
	warn?: (message: string) => void
}

const ALERTER_INSTALL_HINT =
	"install vjeantet/alerter (brew install vjeantet/tap/alerter) and ensure it is on PATH"

export function buildAlerterArguments(options: DesktopNotificationOptions): string[] {
	const argv = ["alerter", "--message", options.message, "--title", options.title]

	if (options.subtitle) {
		argv.push("--subtitle", options.subtitle)
	}

	if (options.sound) {
		argv.push("--sound", options.sound)
	}

	if (options.senderBundleId) {
		argv.push("--sender", options.senderBundleId)
	}

	return argv
}

export async function sendMacOSAlerterNotification(
	options: DesktopNotificationOptions,
	runtime: AlerterRuntime = {},
): Promise<boolean> {
	const which = runtime.which ?? Bun.which
	const warn = runtime.warn ?? console.warn

	try {
		const alerterPath = await which("alerter")
		if (!alerterPath) {
			warn(`notify: macOS desktop notification skipped; alerter not found on PATH (${ALERTER_INSTALL_HINT}).`)
			return false
		}

		const alerterArguments = buildAlerterArguments(options)
		const spawnProcess = runtime.spawnProcess ?? ((argv: string[]) => Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }))
		const process = spawnProcess([alerterPath, ...alerterArguments.slice(1)])
		const exitCode = await process.exited

		if (exitCode === 0) return true

		warn(`notify: macOS desktop notification skipped; alerter exited with code ${exitCode}.`)
		return false
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warn(`notify: macOS desktop notification skipped; alerter failed (${message}).`)
		return false
	}
}

export async function sendDesktopNotificationByPlatform(
	options: DesktopNotificationRouterOptions,
): Promise<void> {
	const { platform, sendNodeNotifierNotification, sendMacOSNotification, sendWSLNotification, ...notificationOptions } = options

	if (platform === "darwin") {
		await (sendMacOSNotification ?? sendMacOSAlerterNotification)(notificationOptions)
		return
	}

	if (platform === "linux" && isWSL()) {
		const sent = await (sendWSLNotification ?? sendWSLWindowsNotification)(notificationOptions)
		if (sent) return
		// Fall through to node-notifier as last resort
	}

	sendNodeNotifierNotification()
}

export async function sendNotificationWithFallback(options: NotifyBackendOptions): Promise<void> {
	if (!options.preferCmux) {
		await options.sendDesktopNotification()
		return
	}

	try {
		const sentViaCmux = await options.tryCmuxNotify()
		if (sentViaCmux) return
	} catch {
		// Fall through to desktop notification fallback
	}

	await options.sendDesktopNotification()
}
