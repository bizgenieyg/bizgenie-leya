import { registry } from './registry.js';
import { AGENT_DEFAULTS } from '../config/agents.js';
for(const [name,defaults]of Object.entries(AGENT_DEFAULTS))registry.register({name,priority:defaults.priority,signals:defaults.signals.map(s=>new RegExp(s,'i')),systemPrompt:defaults.systemPrompt,enabledByDefault:true,actions:['answerFromKnowledge'],execute:core=>core.answerFromKnowledge()});
export {registry,agentContext} from './registry.js';
