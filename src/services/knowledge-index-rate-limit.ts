import{reserveSimulatorCall}from'./simulator-rate-limit.js';
export async function reserveKnowledgeIndex(tenantId:string,hourly:number,daily:number,now=new Date(),root=process.env.KNOWLEDGE_LIMIT_STATE_DIR||'/tmp/leya-knowledge-index-limits'){return reserveSimulatorCall(tenantId,hourly,daily,now,root)}

/** Task Z: voice notes of the owner (knowledge and interview answers): service limits, not the client traffic. */
export async function reserveKnowledgeVoice(tenantId:string,hourly:number,daily:number,now=new Date(),root=process.env.KNOWLEDGE_VOICE_LIMIT_STATE_DIR||'/tmp/leya-knowledge-voice-limits'){return reserveSimulatorCall(tenantId,hourly,daily,now,root)}
