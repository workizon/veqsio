'use client'

import { useState, useCallback } from 'react'
import { Upload, FileText, X, AlertCircle } from 'lucide-react'
import { toast } from './toast'

interface MigrationUploaderProps {
  onUpload: (file: File) => void
  isUploading?: boolean
}

export function MigrationUploader({ onUpload, isUploading }: MigrationUploaderProps) {
  const [dragActive, setDragActive] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const MAX_SIZE = 8 * 1024 * 1024 * 1024 // 8GB (uploaded in chunks; the server limit is MIGRATION_MAX_BYTES)

  const validateFile = (file: File): boolean => {
    if (!file.name.endsWith('.xml')) {
      toast('Please upload a Jira XML backup file (.xml)', 'error')
      return false
    }
    if (file.size > MAX_SIZE) {
      toast('File exceeds 8GB limit', 'error')
      return false
    }
    return true
  }

  const handleFile = useCallback((file: File) => {
    if (validateFile(file)) {
      setSelectedFile(file)
      onUpload(file)
    }
  }, [onUpload])

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0])
    }
  }, [handleFile])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0])
    }
  }, [handleFile])

  const clearFile = useCallback(() => {
    setSelectedFile(null)
  }, [])

  return (
    <div className="w-full">
      <div
        className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
          dragActive
            ? 'border-[var(--brand-500)] bg-[var(--brand-50)]'
            : 'border-[var(--surface-3)] hover:border-[var(--surface-4)]'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept=".xml"
          onChange={handleChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          disabled={isUploading}
        />
        <div className="flex flex-col items-center gap-3 pointer-events-none">
          <div className="w-12 h-12 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
            <Upload className="w-6 h-6 text-[var(--text-tertiary)]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {isUploading ? 'Uploading...' : 'Drag & drop your Jira XML backup'}
            </p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              or click to browse. Max 8GB (.xml)
            </p>
          </div>
        </div>
      </div>

      {selectedFile && (
        <div className="mt-4 flex items-center gap-3 p-3 rounded-lg bg-[var(--surface-1)] border border-[var(--surface-3)]">
          <FileText className="w-5 h-5 text-[var(--brand-500)] flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate">
              {selectedFile.name}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
              {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
            </p>
          </div>
          <button
            onClick={clearFile}
            className="p-1 hover:bg-[var(--surface-3)] rounded transition-colors"
            disabled={isUploading}
          >
            <X className="w-4 h-4 text-[var(--text-tertiary)]" />
          </button>
        </div>
      )}
    </div>
  )
}
