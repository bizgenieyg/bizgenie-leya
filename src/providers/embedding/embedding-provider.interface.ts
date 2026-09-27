export type EmbeddingTask='RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY'|'SEMANTIC_SIMILARITY';
export interface EmbeddingResult{vectors:number[][];inputTokens?:number}
export interface EmbeddingProvider{model:string;dimensions:number;embed(texts:string[],task:EmbeddingTask):Promise<EmbeddingResult>}
