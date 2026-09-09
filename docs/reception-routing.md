# Three-layer conversation routing

The reference implementation in `chef-bot` has no routing rule in `data/knowledge.md`. Its intent-classifier system prompt does distinguish the two modes as follows (kept verbatim as the basis for Leia's classifier):

> SALES — клиент хочет сделать новый заказ, спрашивает про меню, цены, доставку, условия, или это обычное первое обращение.
>
> SUPPORT — клиент пишет про УЖЕ существующий заказ: статус, жалобу, просьбу изменить/отменить/перенести, проблему с доставкой.

Leia first answers an exact FAQ without classification. Campaign keywords, a source marker in the first message, an open case, or one unambiguous agent signal then select a profile deterministically. Otherwise the classifier returns an agent and confidence. Results below the tenant threshold enter RECEPTION. It introduces the assistant once, maintains a natural conversation grounded in tenant knowledge, and asks about the purpose only when useful. It escalates when the client requests the owner, needs a decision outside the assistant's authority, or the conversation reaches a dead end. Unclear routing messages are stored in `unrecognized_routes`.

`conversations.routed_agent` makes the route sticky. A configured keyword for another agent, case closure, or inactivity beyond `route_stickiness_hours` permits reassessment. Agent changes are never announced to the client.

Tenant behavior defaults are `enabled_agents=[SALE,SUPPORT]`, `campaign_routes=[]`, `source_routes=[]`, `intent_confidence_threshold=0.75`, `route_stickiness_hours=24`, and `reception_max_messages=0` (unlimited). The former `default_agent` key is removed by migration 029. `client.reception_question` is a tenant-overridable multilingual template used as natural wording guidance.

To add an agent, register one `AgentDefinition` in the registry with its name, priority, cheap signals, system prompt and core actions. Enable its name for the tenant and optionally reference it in campaign/source routes. Core metering, escalation, quiet hours and message delivery remain outside the agent.
