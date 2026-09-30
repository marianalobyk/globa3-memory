# Legacy system notes

The 15 rows that lived in the production table `Globa 3 Automatization & Memory`,
preserved verbatim before `0021_drop_legacy_tables.sql` removed it.

They are **engineering notes about how the previous memory system was designed**,
not business memory. They were deliberately not migrated into `research_findings`:
putting them there would mean the Ask pipeline answering questions about Globa 3
with the design decisions of the system being replaced. Several of the principles
below still hold and are worth reading; none of them belongs in the memory graph.

The rows also remain in the backup at `~/globa3-backups/prod-2026-09-28T21-09-54/`.

---

## 1.     Parent-child hierarchy as core structure

*system_logic · source:     zoom transcript*

All business units, ventures, and projects must be structured using a parent-child hierarchy.
    Each entity must have a parent_id to enable upward and downward traversal.
    This structure is the foundation for context retrieval and reasoning.

## 2.     Context inheritance via hierarchy

*system_logic · source:     zoom transcript*

Lower-level entities (projects, ventures) inherit context from their parent units.
    AI systems must be able to traverse from a node upward to access broader context when needed.

## 3.     Scoped retrieval must be explicitly controlled

*system_logic · source:     zoom transcript*

AI must not automatically use full hierarchy context.
    Scope (project-level vs parent-level) must be controlled via prompt or instruction.

## 4.     Knowledge linked by business_unit_id

*system_logic · source:     zoom transcript*

All knowledge entries must be linked to a specific business_unit via ID.
    This ensures precise retrieval and prevents context mixing.

## 5.     Rules linked by business_unit_id

*system_logic · source:     zoom transcript*

All rules must be attached to a specific business unit or project.
    Rules define execution behavior within that context and must not be global.

## 6.     Use stable identifiers (slug) for reference

*system_logic · source:     zoom transcript*

Entities and entries must use stable identifiers (slugs or IDs) for referencing.
    Display titles may change, but identifiers must remain constant to avoid breaking memory consistency.

## 7.     Do not store raw transcripts

*workflow · source:     zoom transcript*

Raw meeting transcripts must not be stored in the system.
    All inputs must be processed and reduced to structured, high-value knowledge before storage.

## 8.     Extract → filter → store pipeline

*workflow · source:     zoom transcript*

All incoming information must follow this pipeline:

1. Extract key information using AI
2. Filter for relevance and durability
3. Store only structured outputs in database tables

## 9.     Agents require explicit triggering

*system_logic · source:     zoom transcript*

AI agents do not operate autonomously.
    They must be triggered with instructions or prompts to perform analysis, updates, or retrieval.

## 10.     Fully autonomous AI behavior is not reliable yet

*system_logic · source:     zoom transcript*

Current AI systems cannot be trusted to self-monitor, self-update, or independently generate reliable outputs without explicit control and prompting.

## 11.     Progressive feeding strategy

*workflow · source:     zoom transcript*

System should be populated progressively:
1. Start with parent (Globa 3)
2. Then feed main units
3. Then ventures
4. Then projects
    This ensures coherent context building.

## 12.     Hierarchy defines system behavior

*system_logic · source:     zoom transcript*

System behavior, retrieval logic, and AI reasoning depend on the defined hierarchy.
    Incorrect structure leads to incorrect outputs.

## 13.     Manual validation remains required

*workflow · source:     zoom transcript*

All AI-generated outputs must be reviewed or guided.
    System cannot be fully trusted for autonomous execution.

## 14.     System designed for AI-assisted workflows

*direction · source:     zoom transcript*

The database is designed to support AI-assisted analysis, content generation, and decision support through structured and retrievable context.

## 15.     Use case: content generation and contextual assistance

*direction · source:     zoom transcript*

System should support contextual content generation, scoped knowledge retrieval, and guided AI outputs based on business unit or project context.
