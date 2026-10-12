export interface RagDocument {
  id: string
  title: string
  source: 'text' | 'txt' | 'pdf'
  charCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}

export interface RagChunk {
  id: string
  documentId: string
  documentTitle: string
  index: number
  content: string
  start: number
  end: number
  vector?: Float32Array
  vectorModel?: string
  createdAt: number
}

export interface SearchHit {
  chunk: RagChunk
  score: number
  mode: 'keyword' | 'vector'
}
