import { greet } from "../greet.js";

export function bin(message?: string): void {
	greet({
		logger: console.log.bind(console),
		message: message ?? "Hello, world!",
		times: 3,
	});
}
