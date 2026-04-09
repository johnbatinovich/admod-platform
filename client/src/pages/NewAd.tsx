import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, Upload, Loader2, FileText, Link2, Youtube, Video, CheckCircle, ExternalLink, X, Layers } from "lucide-react";
import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type SourceTab = "upload" | "url";
type ModeTab = "single" | "batch";

interface BatchFile {
  file: File;
  title: string;
  format: "video" | "image" | "audio" | "text" | "rich_media";
  uploadedKey?: string;
  uploadedUrl?: string;
  status: "pending" | "uploading" | "ready" | "error";
}

export default function NewAd() {
  const [, setLocation] = useLocation();
  const [modeTab, setModeTab] = useState<ModeTab>("single");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [sourceTab, setSourceTab] = useState<SourceTab>("upload");
  const [videoUrl, setVideoUrl] = useState("");
  const [isParsingUrl, setIsParsingUrl] = useState(false);

  // Batch state
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [batchSubmitProgress, setBatchSubmitProgress] = useState<number | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [form, setForm] = useState({
    title: "",
    description: "",
    format: "image" as "video" | "image" | "audio" | "text" | "rich_media",
    targetAudience: "",
    priority: "normal" as "low" | "normal" | "high" | "urgent",
    advertiserId: undefined as number | undefined,
    // Upload fields
    fileUrl: "",
    fileKey: "",
    fileName: "",
    fileMimeType: "",
    fileSizeBytes: 0,
    // Video URL fields
    sourceType: "upload" as "upload" | "youtube" | "vimeo" | "direct_url",
    sourceUrl: "",
    videoProvider: "",
    videoId: "",
    embedUrl: "",
    thumbnailUrl: "",
    videoDuration: "",
    videoAuthor: "",
  });

  const { data: advertisers } = trpc.advertisers.list.useQuery();
  const uploadFile = trpc.ads.uploadFile.useMutation();
  const parseVideoUrlMutation = trpc.ads.parseVideoUrl.useMutation();
  const createAd = trpc.ads.create.useMutation({
    onSuccess: (data) => {
      toast.success("Ad submitted successfully");
      setLocation(`/ads/${data.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const createBatch = trpc.ads.createBatch.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} ads submitted — AI review starting in the background`);
      setLocation("/ads");
    },
    onError: (e) => toast.error(e.message),
  });

  const extractVideoThumbnail = (file: File): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!file.type.startsWith("video/")) { resolve(null); return; }
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      video.src = url;
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.preload = "metadata";
      video.onloadeddata = () => {
        video.currentTime = Math.min(1, video.duration * 0.1);
      };
      video.onseeked = () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) { resolve(null); return; }
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.8);
      };
      video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      toast.error("File size must be under 16MB");
      return;
    }
    setIsUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];
        const result = await uploadFile.mutateAsync({
          fileName: file.name,
          fileBase64: base64,
          mimeType: file.type,
        });

        // Extract thumbnail for video uploads
        let thumbnailUrl = "";
        if (file.type.startsWith("video/")) {
          const thumbBase64 = await extractVideoThumbnail(file);
          if (thumbBase64) {
            const thumbResult = await uploadFile.mutateAsync({
              fileName: `thumb_${file.name.replace(/\.[^.]+$/, "")}.jpg`,
              fileBase64: thumbBase64,
              mimeType: "image/jpeg",
            });
            thumbnailUrl = thumbResult.url;
          }
        }

        setForm(prev => ({
          ...prev,
          fileUrl: result.url,
          fileKey: result.key,
          fileName: result.fileName,
          fileMimeType: result.mimeType,
          fileSizeBytes: result.size,
          thumbnailUrl,
          sourceType: "upload",
        }));
        toast.success("File uploaded");
        setIsUploading(false);
      };
      reader.readAsDataURL(file);
    } catch {
      toast.error("Upload failed");
      setIsUploading(false);
    }
  };

  const handleParseVideoUrl = async () => {
    if (!videoUrl.trim()) {
      toast.error("Please enter a video URL");
      return;
    }
    setIsParsingUrl(true);
    try {
      const metadata = await parseVideoUrlMutation.mutateAsync({ url: videoUrl.trim() });
      const sourceType = metadata.provider === "youtube" ? "youtube"
        : metadata.provider === "vimeo" ? "vimeo"
        : "direct_url";

      setForm(prev => ({
        ...prev,
        format: "video",
        sourceType: sourceType as any,
        sourceUrl: videoUrl.trim(),
        videoProvider: metadata.provider,
        videoId: metadata.videoId,
        embedUrl: metadata.embedUrl,
        thumbnailUrl: metadata.thumbnailUrl,
        videoDuration: metadata.duration,
        videoAuthor: metadata.authorName,
        // Auto-fill title if empty
        title: prev.title || metadata.title,
      }));
      toast.success(`${metadata.provider === "youtube" ? "YouTube" : metadata.provider === "vimeo" ? "Vimeo" : "Video"} link parsed successfully`);
    } catch (err: any) {
      toast.error(err.message || "Failed to parse video URL");
    } finally {
      setIsParsingUrl(false);
    }
  };

  const clearVideoUrl = () => {
    setVideoUrl("");
    setForm(prev => ({
      ...prev,
      sourceType: "upload",
      sourceUrl: "",
      videoProvider: "",
      videoId: "",
      embedUrl: "",
      thumbnailUrl: "",
      videoDuration: "",
      videoAuthor: "",
    }));
  };

  const handleSubmit = () => {
    if (!form.title.trim()) {
      toast.error("Title is required");
      return;
    }
    createAd.mutate({
      title: form.title,
      description: form.description || undefined,
      format: form.format,
      targetAudience: form.targetAudience || undefined,
      priority: form.priority,
      advertiserId: form.advertiserId,
      // Upload fields
      fileUrl: form.fileUrl || undefined,
      fileKey: form.fileKey || undefined,
      fileName: form.fileName || undefined,
      fileMimeType: form.fileMimeType || undefined,
      fileSizeBytes: form.fileSizeBytes || undefined,
      // Video URL fields
      sourceType: form.sourceType,
      sourceUrl: form.sourceUrl || undefined,
      videoProvider: form.videoProvider || undefined,
      videoId: form.videoId || undefined,
      embedUrl: form.embedUrl || undefined,
      thumbnailUrl: form.thumbnailUrl || undefined,
      videoDuration: form.videoDuration || undefined,
      videoAuthor: form.videoAuthor || undefined,
    });
  };

  // ── Batch helpers ─────────────────────────────────────────────────────────

  const formatFromMime = (mime: string): BatchFile["format"] => {
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    return "rich_media";
  };

  const titleFromFileName = (name: string) =>
    name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  const addBatchFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const toAdd: BatchFile[] = arr
      .filter(f => f.size <= 16 * 1024 * 1024)
      .map(f => ({
        file: f,
        title: titleFromFileName(f.name),
        format: formatFromMime(f.type),
        status: "pending" as const,
      }));
    if (arr.length !== toAdd.length) toast.error("Some files exceeded 16MB and were skipped");
    setBatchFiles(prev => [...prev, ...toAdd]);
  }, []);

  const handleBatchDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files.length) addBatchFiles(e.dataTransfer.files);
  };

  const handleBatchSubmit = async () => {
    const readyFiles = batchFiles.filter(f => f.status === "pending" || f.status === "ready");
    if (readyFiles.length === 0) { toast.error("No files to submit"); return; }

    // Upload all files first
    setBatchSubmitProgress(0);
    const uploaded: BatchFile[] = [];
    for (let i = 0; i < batchFiles.length; i++) {
      const bf = batchFiles[i];
      setBatchSubmitProgress(Math.round((i / batchFiles.length) * 60));
      setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "uploading" } : f));
      try {
        const reader = new FileReader();
        const base64: string = await new Promise((res, rej) => {
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(bf.file);
        });
        const result = await uploadFile.mutateAsync({ fileName: bf.file.name, fileBase64: base64, mimeType: bf.file.type });
        const updated = { ...bf, uploadedKey: result.key, uploadedUrl: result.url, status: "ready" as const };
        uploaded.push(updated);
        setBatchFiles(prev => prev.map((f, idx) => idx === i ? updated : f));
      } catch {
        setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "error" } : f));
        toast.error(`Failed to upload ${bf.file.name}`);
      }
    }

    setBatchSubmitProgress(70);

    const adsPayload = uploaded.map(bf => ({
      title: bf.title,
      format: bf.format,
      fileUrl: bf.uploadedUrl,
      fileKey: bf.uploadedKey,
      fileName: bf.file.name,
      fileMimeType: bf.file.type,
      fileSizeBytes: bf.file.size,
      sourceType: "upload" as const,
    }));

    if (adsPayload.length === 0) { setBatchSubmitProgress(null); return; }
    setBatchSubmitProgress(85);
    createBatch.mutate({ ads: adsPayload });
    setBatchSubmitProgress(100);
  };

  // ────────────────────────────────────────────────────────────────────────────

  const hasVideoMetadata = form.sourceType !== "upload" && form.embedUrl;
  const providerLabel = form.videoProvider === "youtube" ? "YouTube" : form.videoProvider === "vimeo" ? "Vimeo" : "Video";

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/ads")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Submit New Ad</h1>
          <p className="text-sm text-muted-foreground">Upload a file or paste a YouTube/Vimeo link to submit ad content for review.</p>
        </div>
      </div>

      {/* Mode tabs — Single vs Batch */}
      <Tabs value={modeTab} onValueChange={(v) => setModeTab(v as ModeTab)}>
        <TabsList className="bg-card border border-border">
          <TabsTrigger value="single" className="text-xs gap-1.5">
            <FileText className="h-3.5 w-3.5" />Single Ad
          </TabsTrigger>
          <TabsTrigger value="batch" className="text-xs gap-1.5">
            <Layers className="h-3.5 w-3.5" />Batch Upload
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single">
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-5">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Title *</Label>
            <Input
              placeholder="Enter ad title..."
              value={form.title}
              onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))}
              className="bg-background"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Description</Label>
            <Textarea
              placeholder="Describe the ad content..."
              value={form.description}
              onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
              className="bg-background min-h-[100px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Format *</Label>
              <Select value={form.format} onValueChange={(v: any) => setForm(prev => ({ ...prev, format: v }))}>
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                  <SelectItem value="audio">Audio</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="rich_media">Rich Media</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Priority</Label>
              <Select value={form.priority} onValueChange={(v: any) => setForm(prev => ({ ...prev, priority: v }))}>
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Advertiser</Label>
            <Select
              value={form.advertiserId?.toString() || "none"}
              onValueChange={(v) => setForm(prev => ({ ...prev, advertiserId: v === "none" ? undefined : parseInt(v) }))}
            >
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="Select advertiser..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No advertiser</SelectItem>
                {advertisers?.map(a => (
                  <SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Target Audience</Label>
            <Input
              placeholder="e.g., Adults 18-34, Sports enthusiasts..."
              value={form.targetAudience}
              onChange={e => setForm(prev => ({ ...prev, targetAudience: e.target.value }))}
              className="bg-background"
            />
          </div>

          {/* Creative Source - Tabs for Upload vs URL */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Creative Source</Label>
            <Tabs value={sourceTab} onValueChange={(v) => setSourceTab(v as SourceTab)}>
              <TabsList className="bg-background border border-border w-full">
                <TabsTrigger value="upload" className="flex-1 text-xs gap-1.5">
                  <Upload className="h-3.5 w-3.5" />
                  File Upload
                </TabsTrigger>
                <TabsTrigger value="url" className="flex-1 text-xs gap-1.5">
                  <Link2 className="h-3.5 w-3.5" />
                  Video URL
                </TabsTrigger>
              </TabsList>

              <TabsContent value="upload" className="mt-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,video/*,audio/*,.pdf,.html"
                  onChange={handleFileUpload}
                />
                {form.fileUrl && form.sourceType === "upload" ? (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-background border border-border">
                    <FileText className="h-5 w-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{form.fileName}</p>
                      <p className="text-[11px] text-muted-foreground">{(form.fileSizeBytes / 1024).toFixed(1)} KB</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>Replace</Button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full p-8 rounded-lg border-2 border-dashed border-border hover:border-primary/50 transition-colors text-center"
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
                    ) : (
                      <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    )}
                    <p className="text-sm text-muted-foreground">
                      {isUploading ? "Uploading..." : "Click to upload creative file"}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-1">Max 16MB. Images, video, audio, PDF, HTML.</p>
                  </button>
                )}
              </TabsContent>

              <TabsContent value="url" className="mt-3 space-y-3">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      placeholder="Paste YouTube or Vimeo URL..."
                      value={videoUrl}
                      onChange={e => setVideoUrl(e.target.value)}
                      className="bg-background pr-10"
                      onKeyDown={e => { if (e.key === "Enter") handleParseVideoUrl(); }}
                    />
                    {videoUrl && (
                      <div className="absolute right-2 top-1/2 -translate-y-1/2">
                        {videoUrl.includes("youtube") || videoUrl.includes("youtu.be") ? (
                          <Youtube className="h-4 w-4 text-red-500" />
                        ) : videoUrl.includes("vimeo") ? (
                          <Video className="h-4 w-4 text-blue-600" />
                        ) : (
                          <Link2 className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    )}
                  </div>
                  <Button onClick={handleParseVideoUrl} disabled={isParsingUrl || !videoUrl.trim()}>
                    {isParsingUrl ? <Loader2 className="h-4 w-4 animate-spin" /> : "Parse"}
                  </Button>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Supported: YouTube (youtube.com, youtu.be), Vimeo (vimeo.com), or direct video URLs (.mp4, .webm)
                </p>

                {/* Video Preview Card */}
                {hasVideoMetadata && (
                  <div className="rounded-lg border border-border overflow-hidden bg-background">
                    <div className="relative">
                      {form.thumbnailUrl ? (
                        <img
                          src={form.thumbnailUrl}
                          alt={form.title || "Video thumbnail"}
                          className="w-full h-48 object-cover"
                        />
                      ) : (
                        <div className="w-full h-48 bg-muted flex items-center justify-center">
                          <Video className="h-12 w-12 text-muted-foreground" />
                        </div>
                      )}
                      <div className="absolute top-2 left-2">
                        <Badge className={`text-[10px] ${
                          form.videoProvider === "youtube" ? "bg-red-600 hover:bg-red-700 text-white" :
                          form.videoProvider === "vimeo" ? "bg-blue-500 hover:bg-blue-600 text-white" :
                          "bg-muted"
                        }`}>
                          {providerLabel}
                        </Badge>
                      </div>
                      {form.videoDuration && (
                        <div className="absolute bottom-2 right-2">
                          <Badge variant="secondary" className="text-[10px] bg-black/70 text-white">
                            {form.videoDuration}
                          </Badge>
                        </div>
                      )}
                    </div>
                    <div className="p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{form.title || "Untitled Video"}</p>
                          {form.videoAuthor && (
                            <p className="text-[11px] text-muted-foreground">{form.videoAuthor}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                          <span className="text-[11px] text-green-500 font-medium">Parsed</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <a
                          href={form.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-primary hover:underline flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open original
                        </a>
                        <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={clearVideoUrl}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setLocation("/ads")}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createAd.isPending}>
              {createAd.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Submit for Review
            </Button>
          </div>
        </CardContent>
      </Card>
        </TabsContent>

        {/* ── Batch Upload Tab ───────────────────────────────────────────────── */}
        <TabsContent value="batch">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-5">
              <div>
                <h2 className="text-sm font-semibold mb-0.5">Batch Upload</h2>
                <p className="text-xs text-muted-foreground">Drop multiple files at once. Each ad is auto-titled from the filename. AI review runs sequentially after submission.</p>
              </div>

              {/* Drop zone */}
              <input
                ref={batchInputRef}
                type="file"
                className="hidden"
                multiple
                accept="image/*,video/*,audio/*"
                onChange={e => { if (e.target.files) addBatchFiles(e.target.files); e.target.value = ""; }}
              />
              <div
                onDragOver={e => { e.preventDefault(); setIsDraggingOver(true); }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={handleBatchDrop}
                onClick={() => batchInputRef.current?.click()}
                className={`w-full p-10 rounded-lg border-2 border-dashed transition-colors cursor-pointer text-center ${
                  isDraggingOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                }`}
              >
                <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">
                  {isDraggingOver ? "Drop files here" : "Click or drag files here"}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">Images, video, audio — up to 16MB each, max 20 files</p>
              </div>

              {/* File list */}
              {batchFiles.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""} queued</p>
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] text-destructive" onClick={() => setBatchFiles([])}>Clear all</Button>
                  </div>
                  {batchFiles.map((bf, i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-background border border-border/50">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${
                        bf.status === "ready" ? "bg-green-500" :
                        bf.status === "uploading" ? "bg-yellow-500 animate-pulse" :
                        bf.status === "error" ? "bg-red-500" :
                        "bg-muted-foreground"
                      }`} />
                      <div className="flex-1 min-w-0">
                        <Input
                          value={bf.title}
                          onChange={e => setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, title: e.target.value } : f))}
                          className="h-7 text-xs bg-card border-0 p-0 focus-visible:ring-0 font-medium"
                        />
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {bf.file.name} · {(bf.file.size / 1024).toFixed(0)} KB · {bf.format}
                        </p>
                      </div>
                      <Select value={bf.format} onValueChange={(v: any) => setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, format: v } : f))}>
                        <SelectTrigger className="w-[90px] h-7 text-[11px] bg-card">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="video">Video</SelectItem>
                          <SelectItem value="image">Image</SelectItem>
                          <SelectItem value="audio">Audio</SelectItem>
                          <SelectItem value="rich_media">Rich Media</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => setBatchFiles(prev => prev.filter((_, idx) => idx !== i))}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Progress */}
              {batchSubmitProgress !== null && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {batchSubmitProgress < 70 ? `Uploading files…` :
                       batchSubmitProgress < 100 ? "Submitting to review queue…" :
                       "Done!"}
                    </span>
                    <span>{batchSubmitProgress}%</span>
                  </div>
                  <Progress value={batchSubmitProgress} className="h-1.5" />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setLocation("/ads")}>Cancel</Button>
                <Button
                  onClick={handleBatchSubmit}
                  disabled={batchFiles.length === 0 || createBatch.isPending || batchSubmitProgress !== null}
                >
                  {(createBatch.isPending || batchSubmitProgress !== null) && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  Submit {batchFiles.length > 0 ? `${batchFiles.length} Ad${batchFiles.length !== 1 ? "s" : ""}` : "Ads"} for Review
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
