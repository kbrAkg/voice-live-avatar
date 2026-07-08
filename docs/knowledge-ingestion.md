# Knowledge Ingestion

The purpose of this flow is to move documents from the Blob container into the Search index and to keep the index up to date by watching for blob changes.

## What It Does

- Creates the required Search index.
- Uploads sample documents to the Blob container.
- Reads the blob files.
- Parses text-based files directly.
- Uses Document Intelligence for non-text files.
- Generates a Foundry embedding for each chunk.
- Stores the chunks in the Search index on a per-chunk basis.
- Rewrites the related records when a blob file changes.
- Deletes the Search records when a blob file is removed.

## Setup

```pwsh
cd scripts/knowledge-ingestion
npm install
```

## Initial Setup Sequence

```pwsh
cd scripts/knowledge-ingestion
npm run create-index
npm run upload-samples
npm run sync
```

## Watching for Blob Changes

The command below runs the script in watcher mode. It checks for changes in the Blob container at fixed intervals.

```pwsh
cd scripts/knowledge-ingestion
npm run watch
```

The default polling interval is 60 seconds. If you want, you can add the following fields to `.env`:

```env
KNOWLEDGE_INGESTION_INTERVAL_SECONDS=60
KNOWLEDGE_CHUNK_SIZE=1200
KNOWLEDGE_CHUNK_OVERLAP=200
AZURE_SEARCH_EMBEDDING_DIMENSIONS=1536
AZURE_SEARCH_VECTOR_FIELD=embedding
```

## Expected Result

- Per-chunk documents appear inside `knowledge-index`.
- The MCP service can pull content from Search during `answer_question` calls.
- As you add new files to Blob or update existing files, the index is updated on the next polling cycle.