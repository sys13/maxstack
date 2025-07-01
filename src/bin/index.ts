import { greet } from "../greet.js";

export function bin(message?: string): number {
	greet({
		logger: console.log.bind(console),
		message: message ?? "Hello, world!",
		times: 3,
	});
	return 0;
}
