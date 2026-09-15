export const KNOWLEDGE_DEFAULTS={
 embedding_model:'gemini-embedding-001',embedding_dimensions:768,
 max_files:10,max_file_bytes:10*1024*1024,max_total_bytes:50*1024*1024,
 max_pdf_pages:200,max_characters:500_000,search_results:5,similarity_threshold:.72,
 indexing_hourly_limit:10,indexing_daily_limit:20,
} as const;
export const EMBEDDING_MODELS:Record<string,{dimensions:number;maxInputTokens:number}>={
 'gemini-embedding-001':{dimensions:768,maxInputTokens:20_000},
 'gemini-embedding-2':{dimensions:768,maxInputTokens:8_192},
};
export function embeddingConfig(model=process.env.GEMINI_EMBEDDING_MODEL||KNOWLEDGE_DEFAULTS.embedding_model){const found=EMBEDDING_MODELS[model];if(!found)throw new Error('Unsupported embedding model');return{model,...found};}
