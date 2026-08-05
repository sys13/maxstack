/**
 * Webhooks — signed outbound delivery and verified inbound receivers
 *.
 *
 * Outbound: declared events fan out to subscriber endpoints, signed with a
 * timestamp and a nonce, over URLs validated against every internal address
 * range, with a default-deny field projection so adding a column cannot widen
 * an existing subscription. Inbound: declared receivers whose signature check is
 * unskippable by construction, with replay protection and a uniform 401.
 *
 * Both directions share one signature scheme (`signing.ts`) on purpose.
 */

export type {
	ReceiverDeclaration,
	ReceiverOutcome,
	ReceiverWrite,
} from './inbound.ts'
export {
	MIN_RECEIVER_SECRET_LENGTH,
	ReceiverDeclarationError,
	ReceiverRegistry,
	receiverErrors,
} from './inbound.ts'
export type { FieldProjection } from './projection.ts'
export { isNeverSent, projectionErrors, projectPayload } from './projection.ts'
export { WEBHOOKS_DDL, webhookDelivery, webhookSubscription } from './schema.ts'
export type {
	IssuedSubscription,
	WebhookDeliveryView,
	WebhookEvent,
	WebhookSubscriptionView,
} from './service.ts'
export { WebhookService } from './service.ts'
export type { NonceStore, VerifyFailure, VerifyResult } from './signing.ts'
export {
	createMemoryNonceStore,
	EVENT_HEADER,
	NONCE_HEADER,
	newNonce,
	REPLAY_WINDOW_SECONDS,
	SIGNATURE_HEADER,
	SIGNATURE_VERSION,
	signatureHeaders,
	signBody,
	signedPayload,
	TIMESTAMP_HEADER,
	timingSafeEqualHex,
	verifySignedRequest,
} from './signing.ts'
export type { AddressResolver, SsrfPolicy, SsrfRefusal } from './ssrf.ts'
export {
	assertPublicUrl,
	checkPublicUrl,
	isPrivateHost,
	isPrivateIpv4,
	isPrivateIpv6,
	SsrfRefusedError,
} from './ssrf.ts'
