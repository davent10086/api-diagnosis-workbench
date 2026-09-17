export type Layer="client"|"gateway"|"adapter"|"route"|"provider"|"upstream"|"unknown";
export type Severity="critical"|"high"|"medium"|"low";
export type Trace={requestId?:string;traceId?:string;upstreamRequestId?:string;provider?:string;route?:string;model?:string;statusCode?:number;retryCount?:number;retryReason?:string;clientRequest?:Record<string,unknown>;transformedRequest?:Record<string,unknown>;upstreamResponse?:Record<string,unknown>;finalResponse?:Record<string,unknown>;logs?:string[];sse?:string[]};
export type Finding={ruleId:string;severity:Severity;faultLayer:Layer;conclusion:string;evidence:string[];needsMoreEvidence:boolean};
export type Report={symptom:string;severity:Severity;fault_layer:Layer;confidence:number;evidence:string[];next_checks:string[];external_message:string};
