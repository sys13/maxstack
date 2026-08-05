/**
 * @maxstack/spec-derive — the derivations that turn a spec into the inputs
 * generators need, plus the AI port used to author and cluster spec changes.
 *
 * Four things live here:
 *
 * - **Descriptor derivations** (`pipeline.ts`) — a `SpecSystem` folded into the
 *   per-page, per-schedule, per-importer, per-live and per-source descriptors
 *   the generators consume. Pure, deterministic, no I/O.
 * - **App description** (`describe-app.ts`) — natural language to a validated
 *   `AppBlueprint`, the front half of `maxstack start`.
 * - **The AI port** (`ai.ts`, `agent-runner.ts`) — one `AiClient` interface with
 *   Anthropic, OpenAI and mock transports. `MOCK_AI=1` makes every path keyless
 *   and deterministic, which is why the test suite needs no API key.
 * - **Feedback clustering and ranking** (`clustering.ts`, `priority.ts`) — folds
 *   raw feedback into candidate spec changes and orders them.
 *
 * This barrel names every export explicitly rather than re-exporting whole
 * modules. That is deliberate: a `export *` barrel puts everything reachable
 * from any module into every consumer's import graph, and the CLI should not
 * be transitively importing things it never calls.
 */

export type {
	AgentAttempt,
	AgentMessage,
	AgentRequest,
	AgentRunner,
	AgentRunOptions,
	AgentSession,
	AgentStopReason,
	AgentTransport,
	Workspace,
} from './agent-runner.ts'
export {
	AGENT_TOOLS,
	agentRunner,
	anthropicTransport,
	nodeWorkspace,
	runTool,
	TOOL_RESULT_LIMIT,
} from './agent-runner.ts'
export type { AiClient, AiRequest, TokenUsage } from './ai.ts'
export {
	anthropicAiClient,
	emptyUsage,
	estimateTokens,
	isAiConfigured,
	isMockAi,
	openAiClient,
	selectAiClient,
	sumUsage,
	usageDelta,
	usageOf,
} from './ai.ts'
export type {
	ClusterFn,
	ClusterOptions,
	Issue,
	ProposedCluster,
	ProposeFn,
} from './clustering.ts'
export {
	acceptIssue,
	aiClusterFn,
	clusterFeedback,
	groupByTarget,
	issueKey,
	issueState,
	issueToCandidates,
	landableCandidates,
	parseAiClusters,
	rejectIssue,
} from './clustering.ts'
export type {
	AppBlueprint,
	BlueprintEntity,
	BlueprintSource,
	DescribedApp,
} from './describe-app.ts'
export {
	BLUEPRINT_TYPE_ALIASES,
	blueprintFromDescription,
	buildBlueprintPrompt,
	describeApp,
	normalizeBlueprint,
	parseBlueprint,
	projectSlug,
	titleCase,
} from './describe-app.ts'
export type { E2eSuite, E2eTestCase } from './gen-e2e-tests.ts'
export {
	fillE2eTests,
	genE2eTests,
	planE2eTests,
	renderE2eSuite,
} from './gen-e2e-tests.ts'
export { MOCK_GENERATORS, mockAiClient } from './mocks/openai.ts'
export {
	availableBlockSlots,
	IMPORT_SLOT_PREFIX,
	LIVE_SLOT_PREFIX,
	pageToDescriptor,
	resourceOf,
	SCHEDULE_SLOT_PREFIX,
	SOURCE_SLOT_PREFIX,
	slotsOf,
	specToDescriptors,
	specToImporterDescriptors,
	specToLiveDescriptors,
	specToScheduleDescriptors,
	specToSourceDescriptors,
} from './pipeline.ts'
export type {
	PriorityCandidate,
	PriorityFactors,
	RankedCandidate,
	SeverityKind,
} from './priority.ts'
export {
	computePriority,
	SEVERITY_WEIGHTS,
	scoreCandidate,
} from './priority.ts'
export type {
	ExampleApp,
	ExampleChange,
	OffSurfaceCluster,
} from './types.ts'
export { CHANGE_WEIGHTS, changeWeight, isResidual } from './weights.ts'
