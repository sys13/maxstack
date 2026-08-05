/**
 * Product Requirements Document (PRD) — comprehensive type definition (v3).
 *
 * v3 changelog (schema improvements found by using v2 on a real product):
 *   - IDs are now category-typed via prefix templates (MetricId = `m-${string}`
 *     etc.) so you can't pass a requirement id where a metric id is expected —
 *     compile-time safety with zero authoring overhead. Existence of a
 *     referenced id is enforced at runtime by prd.schema.ts.
 *   - Assumptions and Risks are SEPARATE types. A risk threatens an assumption;
 *     cramming both into one interface was a modeling error.
 *   - `severity` is no longer stored — it's DERIVED from likelihood × impact via
 *     deriveSeverity(), so the label can't drift out of sync with the numbers.
 *   - Metrics link to the analytics events that measure them and carry a
 *     baseline — closing the gap where metrics and instrumentation were
 *     disconnected.
 *   - Owners are traceable: requirements/risks/metrics/milestones take an
 *     ownerId referencing a Stakeholder.
 *   - Estimate units are a single project-level enum, so efforts are comparable
 *     and a phase's effort is the sum of its requirements' (see derivePhaseEffort).
 *   - Requirements can declare they ENHANCE an existing requirement, so v1/v2
 *     phases reference real new work instead of re-pointing at MVP requirements.
 *   - schemaVersion + runtime-validated ISO dates.
 */

export const SCHEMA_VERSION = "3.0.0";

// ===========================================================================
// Identifier types — category-safe via prefix templates
// ===========================================================================
// Each entity owns a prefix. The template-literal type means a plain string
// literal like "m-coverage" is automatically the right branded type, while
// "r-people" is rejected anywhere a MetricId is required. Prefixes are disjoint.

export type StakeholderId = `sh-${string}`;
export type MetricId = `m-${string}`;
export type EventId = `ev-${string}`;
export type GoalId = `bg-${string}` | `ug-${string}`;
export type ActivityId = `a-${string}`;
export type RequirementId = `r-${string}`;
export type ScopeItemId = `s-${string}`;
export type AssumptionId = `as-${string}`;
export type RiskId = `rk-${string}`;
export type PhaseId = `p-${string}`;
export type MilestoneId = `ms-${string}`;
export type DecisionId = `d-${string}`;

/** YYYY-MM-DD. Format is enforced at runtime by the schema, not the type. */
export type ISODate = string;

// ===========================================================================
// Shared building blocks
// ===========================================================================

/** Quantified estimate. Units are project-wide (PRD.estimateUnit), not per-item. */
export interface Estimate {
  effort: number;
  /** Expected impact on the north-star or a referenced goal. */
  impact: number;
  /** 0–1 confidence in these numbers; low confidence flags a need to validate. */
  confidence: number;
}

export type EstimateUnit = "person-days" | "story-points";

export interface Rationale {
  reasoning: string;
  heuristicApplied?: string;
}

export type Severity = "low" | "medium" | "high";

/**
 * Severity is DERIVED, never stored — this is the single source of truth so a
 * hand-typed label can't contradict the likelihood/impact numbers.
 */
export function deriveSeverity(likelihood: number, impact: number): Severity {
  const score = likelihood * impact;
  if (score >= 0.4) return "high";
  if (score >= 0.15) return "medium";
  return "low";
}

/** Sum of effort across a phase's requirements — phase effort is derived, not typed by hand. */
export function derivePhaseEffort(
  phase: RoadmapPhase,
  requirements: Requirement[],
): number {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  return phase.featureRequirementIds.reduce(
    (sum, id) => sum + (byId.get(id)?.estimate?.effort ?? 0),
    0,
  );
}

// ===========================================================================
// Root
// ===========================================================================

export interface PRD {
  schemaVersion: string;
  /** Single unit for every Estimate in the doc, so efforts are comparable. */
  estimateUnit: EstimateUnit;
  meta: DocumentMeta;
  context: Context;
  problem: ProblemDefinition;
  discovery: DiscoveryProcess;
  audience: Audience;
  market: MarketLandscape;
  goals: GoalsAndMetrics;
  scope: Scope;
  requirements: Requirement[];
  experience: ExperienceDesign;
  technical: TechnicalShape;
  nonFunctional: NonFunctionalRequirements;
  businessModel?: BusinessModel;
  constraints: Constraints;
  /** Things believed true that the plan rests on. */
  assumptions: Assumption[];
  /** Things that could go wrong — each may threaten one or more assumptions. */
  risks: Risk[];
  validation: ValidationPlan;
  roadmap: Roadmap;
  execution: ExecutionPlan;
  coexistence: CoexistenceConcerns;
  postLaunch: PostLaunch;
  openQuestions: OpenQuestion[];
  decisions?: DecisionRecord[];
  glossary?: GlossaryEntry[];
}

// ===========================================================================
// Document framing
// ===========================================================================

export interface DocumentMeta {
  title: string;
  author: string;
  status: "draft" | "in_review" | "approved" | "deprecated";
  version: string;
  lastUpdated: ISODate;
  approvers: Stakeholder[];
  stakeholders?: Stakeholder[];
  revisionHistory?: Revision[];
}

export interface Revision {
  version: string;
  date: ISODate;
  author: string;
  summary: string;
}

export interface Stakeholder {
  id: StakeholderId;
  name: string;
  role: string;
  involvement: "approver" | "consulted" | "informed" | "responsible";
}

// ===========================================================================
// Context & problem
// ===========================================================================

export interface Context {
  tldr: string;
  background: string;
}

export interface ProblemDefinition {
  statement: string;
  costOfInaction: string;
  painkillerOrVitamin: "painkiller" | "vitamin";
}

// ===========================================================================
// Discovery process
// ===========================================================================

export interface DiscoveryProcess {
  activities: Activity[];
  researchMethod?: ResearchMethod;
}

export interface Activity {
  id: ActivityId;
  description: string;
  type:
    | "user_research"
    | "prototyping"
    | "technical_spike"
    | "experiment"
    | "design"
    | "other";
  status: "planned" | "in_progress" | "done" | "skipped";
  outcome?: string;
}

export interface ResearchMethod {
  approach: string;
  sampleSize?: number;
  whoWasResearched?: string;
}

// ===========================================================================
// Audience
// ===========================================================================

export interface Audience {
  personas: Persona[];
  jobsToBeDone: string[];
  currentWorkarounds: string[];
  researchEvidence?: string[];
  researchMethod?: ResearchMethod;
}

export interface Persona {
  name: string;
  description: string;
  contextOfUse: string;
  goals: string[];
  frustrations: string[];
  /** Not every persona is a user — some are affected parties (e.g. recipients). */
  relationshipToProduct?: "primary_user" | "secondary_user" | "affected_party";
}

// ===========================================================================
// Market
// ===========================================================================

export interface MarketLandscape {
  competitors: Competitor[];
  differentiation: string;
}

export interface Competitor {
  name: string;
  type: "direct" | "indirect";
  strengths: string[];
  weaknesses: string[];
}

// ===========================================================================
// Goals & metrics
// ===========================================================================

export interface GoalsAndMetrics {
  northStarMetric: Metric;
  businessGoals: Goal[];
  userGoals: Goal[];
  goalAlignment: GoalTension[];
  supportingMetrics: Metric[];
  guardrailMetrics?: Metric[];
  horizonViews?: HorizonView[];
}

export interface Goal {
  id: GoalId;
  statement: string;
}

export interface GoalTension {
  businessGoalId: GoalId;
  userGoalId: GoalId;
  tension: string;
  resolution: string;
}

export interface HorizonView {
  horizon: string;
  whatSuccessLooksLike: string;
}

export interface Metric {
  id: MetricId;
  name: string;
  definition: string;
  /** Where we are today; for a new product this may be 0. */
  baseline?: number;
  target?: string;
  timeframe?: string;
  /** The analytics events this metric is actually computed from — traceability. */
  measuredByEventIds?: EventId[];
  ownerId?: StakeholderId;
}

// ===========================================================================
// Scope
// ===========================================================================

export interface Scope {
  mustHave: ScopeItem[];
  shouldHave: ScopeItem[];
  couldHave: ScopeItem[];
  wontHave: ScopeItem[];
  nonGoals: string[];
}

export interface ScopeItem {
  id: ScopeItemId;
  description: string;
  rationale?: Rationale;
  /** If this scope item became a tracked requirement, link it. */
  realizedByRequirementId?: RequirementId;
}

// ===========================================================================
// Requirements
// ===========================================================================

export interface Requirement {
  id: RequirementId;
  userStory: string;
  acceptanceCriteria: string[];
  priority: "P0" | "P1" | "P2" | "P3";
  priorityRationale?: Rationale;
  estimate?: Estimate;
  servesMetricIds?: MetricId[];
  edgeCasesAndErrorStates: string[];
  interactionsWithExisting?: string[];
  /** Requirements this one extends — lets later phases add real new work. */
  enhancesRequirementIds?: RequirementId[];
  ownerId?: StakeholderId;
}

// ===========================================================================
// Experience & design
// ===========================================================================

export interface ExperienceDesign {
  criticalUserFlows: UserFlow[];
  firstRunExperience: string;
  informationArchitecture?: string;
  designLinks?: string[];
  accessibility: AccessibilityRequirements;
  localization?: LocalizationRequirements;
}

export interface UserFlow {
  name: string;
  steps: string[];
  /** Which requirements implement this flow — traceability. */
  requirementIds?: RequirementId[];
}

export interface AccessibilityRequirements {
  standard?: string;
  considerations: string[];
}

export interface LocalizationRequirements {
  languages: string[];
  considerations: string[];
}

// ===========================================================================
// Technical
// ===========================================================================

export interface TechnicalShape {
  platforms: Platform[];
  platformStrategy?: string;
  dataModel: string;
  integrations: Integration[];
  dataMigration?: string;
}

export type Platform = "web" | "ios" | "android" | "desktop" | "api";

export interface Integration {
  name: string;
  purpose: string;
}

// ===========================================================================
// Non-functional
// ===========================================================================

export interface NonFunctionalRequirements {
  performanceTargets: string[];
  scalability: string;
  security: string[];
  compliance?: string[];
  availability?: string;
  offlineSupport?: boolean;
}

// ===========================================================================
// Business model
// ===========================================================================

export interface BusinessModel {
  type:
    | "subscription"
    | "one_time_purchase"
    | "freemium"
    | "ads"
    | "transaction_fee"
    | "free";
  unitEconomics?: UnitEconomics;
  pricingNotes?: string;
}

/** Per-unit economics broken out — critical for physical-goods products. */
export interface UnitEconomics {
  /** Average revenue per customer per period. */
  revenuePerCustomer: number;
  /** Line-item costs to serve one customer (print, postage, generation, etc.). */
  costLineItems: { label: string; amount: number }[];
  customerAcquisitionCost?: number;
  currency: string;
  notes?: string;
}

// ===========================================================================
// Constraints
// ===========================================================================

export interface Constraints {
  budget?: string;
  timeline?: string;
  teamCapacity?: string;
  regulatoryOrPolicy?: string[];
  resourcingCaveats?: string[];
}

// ===========================================================================
// Assumptions & risks (now separate)
// ===========================================================================

export interface Assumption {
  id: AssumptionId;
  statement: string;
  /** 0–1. */
  confidence: number;
  /** 0–1: how bad it is if this turns out false. */
  impactIfWrong: number;
  /** The discovery activity that tests it. */
  validatedByActivityId?: ActivityId;
  ownerId?: StakeholderId;
}

export interface Risk {
  id: RiskId;
  description: string;
  type: "technical_risk" | "market_risk" | "dependency_risk" | "operational_risk";
  /** 0–1 each. Severity is derived from these via deriveSeverity(). */
  likelihood: number;
  impact: number;
  /** Assumption(s) this risk would invalidate. */
  threatensAssumptionIds?: AssumptionId[];
  mitigation: string;
  validatedByActivityId?: ActivityId;
  ownerId?: StakeholderId;
}

// ===========================================================================
// Validation gate
// ===========================================================================

export interface ValidationPlan {
  isGate: boolean;
  goCriteria: string;
  noGoCriteria?: string;
  experiments: string[];
  blocksPhaseId?: PhaseId;
}

// ===========================================================================
// Roadmap & execution
// ===========================================================================

export interface Roadmap {
  phases: RoadmapPhase[];
}

export interface RoadmapPhase {
  id: PhaseId;
  name: string;
  goal: string;
  featureRequirementIds: RequirementId[];
  /** impact/confidence here; effort should be derived via derivePhaseEffort(). */
  estimate?: Estimate;
  dependsOnPhaseIds?: PhaseId[];
}

export interface ExecutionPlan {
  milestones: Milestone[];
  launchPlan: LaunchPlan;
  /** First-class events so metrics can reference what measures them. */
  analyticsEvents: AnalyticsEvent[];
  qualityBar: string;
  userCommunicationPlan: string;
  internalEnablement?: string;
}

export interface AnalyticsEvent {
  id: EventId;
  name: string;
  description: string;
}

export interface Milestone {
  id: MilestoneId;
  name: string;
  date: ISODate;
  deliverable: string;
  deliversRequirementIds?: RequirementId[];
  ownerId?: StakeholderId;
}

export interface LaunchPlan {
  softLaunch?: { audience: string; successCriteria: string };
  generalAvailability: { criteria: string };
  rolloutStrategy?: string;
}

// ===========================================================================
// Coexistence
// ===========================================================================

export interface CoexistenceConcerns {
  permissionsAndRoles: string[];
  featureInteractions: string[];
  dependencies: string[];
  vendorRisks: VendorRisk[];
}

export interface VendorRisk {
  vendor: string;
  whatItProvides: string;
  contingency: string;
}

// ===========================================================================
// Post-launch
// ===========================================================================

export interface PostLaunch {
  ownership: string;
  killCriteria: KillCriterion[];
  rollbackPlan: string;
  costOverTime?: CostProjection[];
  dataRetention?: string;
}

export interface KillCriterion {
  metricId: MetricId;
  threshold: string;
  action: "kill" | "pivot" | "reassess";
}

export interface CostProjection {
  scale: string;
  estimatedMonthlyCost: number;
  currency?: string;
}

// ===========================================================================
// Loose ends
// ===========================================================================

export interface OpenQuestion {
  question: string;
  owner?: string;
  blocking: boolean;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface DecisionRecord {
  id: DecisionId;
  decision: string;
  chosenOption: string;
  rejectedAlternatives: { option: string; whyRejected: string }[];
  date: ISODate;
}
