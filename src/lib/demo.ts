import type { Trace } from "./types";

export const demoTrace:Trace={requestId:"req_bedrock_2026",traceId:"tr_8f1a",provider:"Bedrock",route:"bedrock/claude",model:"claude-3-7-sonnet",statusCode:400,clientRequest:{model:"claude-3-7-sonnet",tools:[{type:"web_search_20250305"}],max_tokens:1024},transformedRequest:{model:"claude-3-7-sonnet",tools:[{type:"web_search_20250305"}],max_tokens:1024},upstreamResponse:{__type:"ValidationException",message:"Unsupported tool type web_search_20250305"},logs:["upstream returned ValidationException"],sse:[]};
