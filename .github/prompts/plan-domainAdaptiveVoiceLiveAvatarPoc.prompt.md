## Plan: Domain-Adaptive Voice Live Avatar PoC

A multilingual (TR+EN) voice avatar assistant PoC will be prepared in East US 2 under a single resource group, based on the reference architecture. The default vertical profile will be teacher; however, file/folder/module names will be domain-agnostic, and behavior profile will be switchable via configuration. The solution will implement a Voice Live + Azure Speech Avatar + RAG (Blob -> Document Intelligence -> Azure AI Search) flow; authentication/authorization will use Managed Identity + RBAC. Application infrastructure and service setup will be defined with Bicep, and deployment flow will be standardized with azd.

**Steps**
1. Phase 1 - Solution Skeleton and Reference Alignment
2. Since the current workspace is empty, a right-sized derivative of the reference repo structure will be created for PoC needs (frontend, backend, mcp-server, infra, scripts, docs).
3. Modes to support will be finalized: Voice-Only + Video Avatar. All modes are enabled in initial scope, with Voice-Only defined as fallback.
4. Phase 2 - Region and Service Topology Design
5. Single-RG strategy: all Azure resources will be provisioned under the same resource group.
6. Primary region will be East US 2. Rationale: Speech avatar and Voice Live compatibility, alignment with the reference repo, and broad model/service availability.
7. Services and regional alignment:
8. Azure Speech (S0, East US 2) - real-time avatar and STT/TTS.
9. Azure AI Foundry/Azure OpenAI (East US 2) - gpt-realtime + gpt-4.1 + text-embedding-3-large deployments.
10. Azure AI Search (East US 2) - hybrid/vector retrieval.
11. Azure Document Intelligence (East US 2) - document extraction.
12. Azure Storage Account + Blob container (East US 2) - source document repository.
13. Azure Container Registry (East US 2) - image registry.
14. Azure Container Apps Environment + 3 apps (frontend, backend, mcp-server) (East US 2).
15. Log Analytics + App Insights (East US 2) - observability.
16. Phase 3 - Security and Identity Design
17. To minimize API key dependency, system-assigned managed identity will be enabled on Container Apps.
18. RBAC assignments will be defined in Bicep:
19. Backend MI -> Cognitive Services User (Speech), OpenAI User/Contributor (as required), Search Index Data Reader.
20. MCP MI -> Search Index Data Reader/Contributor (based on indexing flow), Storage Blob Data Reader.
21. Required roles for the document processing pipeline will be assigned to the script-running identity (deployment principal or optional user-assigned MI).
22. Key Vault option will be planned as PoC v1.1 (not mandatory in v1, but documented as an extension point).
23. Phase 4 - Bicep Design and File Plan
24. Main Bicep topology will be designed modularly:
25. main.bicep: RG-level orchestration and module invocations.
26. modules/resource-group-conventions.bicep: naming/tag parameters.
27. modules/speech.bicep, modules/openai.bicep, modules/search.bicep, modules/document-intelligence.bicep, modules/storage.bicep.
28. modules/container-registry.bicep, modules/container-app-env.bicep, modules/container-app.bicep.
29. modules/logging.bicep (Log Analytics + App Insights).
30. modules/rbac.bicep: role assignment matrix.
31. main.parameters.json: environment-based (dev/test) parameter sets.
32. Region parameter in Bicep will default to eastus2; capacity/sku/feature flags will be externally overridable.
33. Phase 5 - Application Configuration and RAG Flow
34. Backend config:
35. Voice Live token/session endpoints.
36. Speech token + avatar relay token integration.
37. Chat fallback endpoint (for video/photo modes).
38. MCP server config:
39. answer_question tool, Azure AI Search hybrid query, citation response.
40. Blob -> Doc Intelligence -> chunk -> embedding -> Search index pipeline script.
41. Frontend config:
42. TR+EN language selection, mode switch (voice/video/photo), avatar selection, voice selection.
43. Default teacher persona/system instructions and safe-response constraints (switchable by vertical via config).
44. Phase 6 - Deployment and Setup Flow
45. azd-based deployment artifacts will be prepared (azure.yaml + env settings + hooks).
46. Post-provision hook will trigger index creation and document processing.
47. azd env and infra parameters will be fixed so all resources deploy into a single RG.
48. Setup steps will be documented: pre-req, az login, azd up, validation, troubleshooting.
49. Phase 7 - Validation and Acceptance Criteria
50. Infrastructure validation:
51. Clean Bicep what-if result, role assignments created, container apps healthy.
52. Functional validation:
53. TR/EN Q&A in voice-only mode.
54. Lip-sync and latency target in video avatar mode.
56. RAG validation:
57. Citation-based answers from sample documents uploaded to Blob.
58. Non-functional validation:
59. Baseline log/trace visibility, error metrics, reconnect behavior.

**Dependencies and Parallelism**
1. Phase 2 cannot start before Phase 1 is complete.
2. Phase 2 (region/service decisions) blocks Phase 4.
3. Phase 3 (RBAC matrix) can start in parallel with Phase 4, but must complete before final Bicep outputs.
4. Phase 5 application configuration depends on Phase 4 infrastructure outputs.
5. Phase 6 deployment flow cannot start before Phases 4 and 5 are complete.
6. Phase 7 runs after all phases are complete.

**Relevant files**
- New project skeleton under workspace root
- Main and module-based Bicep files under infra
- Frontend, backend, mcp-server sources for application layers
- azd/yaml, scripts, and documentation for deployment and operations
- Configuration layer for domain profile (e.g., assistant-profile, domain-policy, prompt-profile)

**Naming strategy (mandatory)**
1. File/folder/module names must not contain vertical-specific terms such as teacher, health, sales.
2. Domain behavior must be determined via configuration, not code naming.
3. Common naming set will be used: assistant-app, orchestration-api, rag-service, knowledge-ingestion, infra/modules.
4. Vertical-specific differences will be managed via profile files/environment variables (e.g., ASSISTANT_DOMAIN=education/health/sales).

**Verification**
1. Bicep lint and what-if for schema/permission/dependsOn validation.
2. Resource inventory check after azd provision (single RG, correct region, correct SKU).
3. Container Apps health endpoint checks.
4. Voice Live session initialization + Speech avatar streaming test (WebRTC).
5. 10+ RAG Q&A test cases (TR+EN, citation expected).
6. RBAC negative tests (is unauthorized access blocked?).
7. Operational logs visibility in Log Analytics/App Insights.

**Decisions**
- Included: Single RG, East US 2, Managed Identity + RBAC, Blob-based RAG, 3-mode avatar experience, default teacher behavior profile + domain-agnostic naming standard.
- Excluded: Production-grade HA/DR, multi-region failover, advanced cost optimization, mandatory Key Vault integration (outside v1).

**Further Considerations**
1. For cost/performance balance, start with Search S1 and minimum ACA replicas, then calibrate autoscale under load.
2. Add mandatory Chrome and Edge tests to PoC acceptance criteria for avatar mode browser compatibility.
3. Run A/B testing for default TR voice quality (DragonHD vs multilingual neural).