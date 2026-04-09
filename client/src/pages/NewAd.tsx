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
import {
  ArrowLeft, Upload, Loader2, FileText, Link2, Youtube, Video,
  CheckCircle, ExternalLink, X, Layers, Sparkles, AlertTriangle,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
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
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [sourceTab, setSourceTab] = useState<SourceTab>("upload");
  const [videoUrl, setVideoUrl] = useState("");
  const [isParsingUrl, setIsParsingUrl] = useState(false);

  // AI suggestion tracking
  const [aiSuggested, setAiSuggested] = useState<Record<string, boolean>>({});

  // Advertiser text input (separate from form.advertiserId)
  const [advertiserName, setAdvertiserName] = useState("");
  const [advertiserMatch, setAdvertiserMatch] = useState<{
    existingId: number;
    existingName: string;
    confidence: string;
    matchReason: string;
  } | null>(null);

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

  // ── tRPC hooks ─────────────────────────────────────────────────────────────
  const uploadFile = trpc.ads.uploadFile.useMutation();
  const analyzeCreative = trpc.ads.analyzeCreative.useMutation();
  const parseVideoUrlMutation = trpc.ads.parseVideoUrl.useMutation();
  const matchAdvertiserFull = trpc.ads.matchAdvertiserFull.useMutation();
  const createAdvertiserMutation = trpc.advertisers.create.useMutation();
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

  // Reactive advertiser match check (L1-L3, no LLM) — fires when advertiserName changes
  const checkMatch = trpc.ads.checkAdvertiserMatch.useQuery(
    { name: advertiserName },
    { enabled: advertiserName.trim().length >= 2, refetchOnWindowFocus: false },
  );

  // Sync checkMatch result into state
  useEffect(() => {
    if (checkMatch.data?.match) {
      setAdvertiserMatch(checkMatch.data.match);
      setForm(prev => ({ ...prev, advertiserId: checkMatch.data!.match!.existingId }));
    } else if (checkMatch.data && !checkMatch.data.match && advertiserName.trim()) {
      setAdvertiserMatch(null);
      setForm(prev => ({ ...prev, advertiserId: undefined }));
    }
  }, [checkMatch.data]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const extractVideoThumbnail = (file: File): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!file.type.startsWith("video/")) { resolve(null); return; }
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      video.src = url;
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.preload = "metadata";
      video.onloadeddata = () => { video.currentTime = Math.min(1, video.duration * 0.1); };
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

  // ── handleFileUpload: upload then analyze ─────────────────────────────────

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) { toast.error("File size must be under 16MB"); return; }

    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(",")[1];
        const result = await uploadFile.mutateAsync({
          fileName: file.name,
          fileBase64: base64,
          mimeType: file.type,
        });

        // Extract and upload client-side thumbnail for video
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
        setIsUploading(false);
        toast.success("File uploaded");

        // ── AI creative analysis ─────────────────────────────────────────────
        setIsAnalyzing(true);
        try {
          const analysis = await analyzeCreative.mutateAsync({
            fileKey: result.key,
            mimeType: file.type,
            originalFilename: file.name,
          });

          const suggested: Record<string, boolean> = {};

          setForm(prev => {
            const updates: Partial<typeof prev> = {};
            if (analysis.suggestedTitle) { updates.title = analysis.suggestedTitle; suggested.title = true; }
            if (analysis.suggestedDescription) { updates.description = analysis.suggestedDescription; suggested.description = true; }
            if (analysis.detectedFormat && ["video", "image", "audio", "text", "rich_media"].includes(analysis.detectedFormat)) {
              updates.format = analysis.detectedFormat as typeof prev.format;
              suggested.format = true;
            }
            if (analysis.suggestedTargetAudience) { updates.targetAudience = analysis.suggestedTargetAudience; suggested.targetAudience = true; }
            return { ...prev, ...updates };
          });

          if (analysis.detectedAdvertiser) {
            setAdvertiserName(analysis.detectedAdvertiser.name);
            if (analysis.detectedAdvertiser.existingId) {
              setAdvertiserMatch({
                existingId: analysis.detectedAdvertiser.existingId,
                existingName: analysis.detectedAdvertiser.name,
                confidence: analysis.detectedAdvertiser.confidence ?? "medium",
                matchReason: analysis.detectedAdvertiser.matchReason ?? "",
              });
              setForm(prev => ({ ...prev, advertiserId: analysis.detectedAdvertiser!.existingId! }));
            } else {
              setAdvertiserMatch(null);
            }
            suggested.advertiser = true;
          }

          setAiSuggested(suggested);
        } catch (err) {
          console.warn("[analyzeCreative] Analysis failed, manual entry required:", err);
        } finally {
          setIsAnalyzing(false);
        }
      } catch {
        toast.error("Upload failed");
        setIsUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // ── handleParseVideoUrl: parse then analyze ───────────────────────────────

  const handleParseVideoUrl = async () => {
    if (!videoUrl.trim()) { toast.error("Please enter a video URL"); return; }
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
        title: prev.title || metadata.title,
      }));
      setIsParsingUrl(false);
      toast.success("Video link parsed");
    } catch (err: any) {
      toast.error(err.message || "Failed to parse video URL");
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

  // ── handleSubmit ───────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!form.title.trim()) { toast.error("Title is required"); return; }

    let finalAdvertiserId = form.advertiserId;

    // If advertiser name set but no DB link → run full LLM match, then create
    if (advertiserName.trim() && !finalAdvertiserId) {
      try {
        const finalCheck = await matchAdvertiserFull.mutateAsync({ name: advertiserName.trim() });
        if (finalCheck.match) {
          finalAdvertiserId = finalCheck.match.existingId;
        } else {
          const newAdv = await createAdvertiserMutation.mutateAsync({ name: advertiserName.trim() });
          finalAdvertiserId = newAdv.id;
        }
      } catch (err) {
        console.warn("[NewAd] Advertiser resolve failed, submitting without:", err);
      }
    }

    createAd.mutate({
      title: form.title,
      description: form.description || undefined,
      format: form.format,
      targetAudience: form.targetAudience || undefined,
      priority: form.priority,
      advertiserId: finalAdvertiserId,
      fileUrl: form.fileUrl || undefined,
      fileKey: form.fileKey || undefined,
      fileName: form.fileName || undefined,
      fileMimeType: form.fileMimeType || undefined,
      fileSizeBytes: form.fileSizeBytes || undefined,
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

  // ── Batch helpers ──────────────────────────────────────────────────────────

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
      .map(f => ({ file: f, title: titleFromFileName(f.name), format: formatFromMime(f.type), status: "pending" as const }));
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
      title: bf.title, format: bf.format,
      fileUrl: bf.uploadedUrl, fileKey: bf.uploadedKey,
      fileName: bf.file.name, fileMimeType: bf.file.type,
      fileSizeBytes: bf.file.size, sourceType: "upload" as const,
    }));
    if (adsPayload.length === 0) { setBatchSubmitProgress(null); return; }
    setBatchSubmitProgress(85);
    createBatch.mutate({ ads: adsPayload });
    setBatchSubmitProgress(100);
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const hasVideoMetadata = form.sourceType !== "upload" && form.embedUrl;
  const providerLabel = form.videoProvider === "youtube" ? "YouTube" : form.videoProvider === "vimeo" ? "Vimeo" : "Video";
  const isSubmitting = createAd.isPending || matchAdvertiserFull.isPending || createAdvertiserMutation.isPending;

  const AiBadge = ({ field }: { field: string }) =>
    aiSuggested[field] ? (
      <Badge variant="outline" className="ml-2 text-[10px] border-purple-300 text-purple-600 font-normal py-0">
        ✨ AI suggested
      </Badge>
    ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/ads")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Submit New Ad</h1>
          <p className="text-sm text-muted-foreground">Upload a file or paste a video link — AI will pre-fill the form using vision and audio analysis.</p>
        </div>
      </div>

      <Tabs value={modeTab} onValueChange={(v) => setModeTab(v as ModeTab)}>
        <TabsList className="bg-card border border-border">
          <TabsTrigger value="single" className="text-xs gap-1.5">
            <FileText className="h-3.5 w-3.5" />Single Ad
          </TabsTrigger>
          <TabsTrigger value="batch" className="text-xs gap-1.5">
            <Layers className="h-3.5 w-3.5" />Batch Upload
          </TabsTrigger>
        </TabsList>

        {/* ── Single Ad Tab ───────────────────────────────────────────────── */}
        <TabsContent value="single">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-5">

              {/* Creative Source */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Creative Source</Label>
                <Tabs value={sourceTab} onValueChange={(v) => setSourceTab(v as SourceTab)}>
                  <TabsList className="bg-background border border-border w-full">
                    <TabsTrigger value="upload" className="flex-1 text-xs gap-1.5">
                      <Upload className="h-3.5 w-3.5" />File Upload
                    </TabsTrigger>
                    <TabsTrigger value="url" className="flex-1 text-xs gap-1.5">
                      <Link2 className="h-3.5 w-3.5" />Video URL
                    </TabsTrigger>
                  </TabsList>

                  {/* Upload tab */}
                  <TabsContent value="upload" className="mt-3 space-y-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      accept="image/*,video/*,audio/*,.pdf,.html"
                      onChange={handleFileUpload}
                    />
                    {form.fileUrl && form.sourceType === "upload" ? (
                      <>
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-background border border-border">
                          <FileText className="h-5 w-5 text-primary shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{form.fileName}</p>
                            <p className="text-[11px] text-muted-foreground">{(form.fileSizeBytes / 1024).toFixed(1)} KB</p>
                          </div>
                          <Button
                            variant="ghost" size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              setForm(prev => ({ ...prev, fileUrl: "", fileKey: "", fileName: "", fileMimeType: "", fileSizeBytes: 0, thumbnailUrl: "", sourceType: "upload" }));
                              setAiSuggested({});
                              setAdvertiserName("");
                              setAdvertiserMatch(null);
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                        {isAnalyzing && (
                          <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            <span className="text-sm text-muted-foreground">Analyzing creative with AI…</span>
                          </div>
                        )}
                      </>
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
                          {isUploading ? "Uploading…" : "Click to upload creative file"}
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-1">Max 16MB. Images, video, audio, PDF, HTML.</p>
                      </button>
                    )}
                  </TabsContent>

                  {/* URL tab */}
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

                    {hasVideoMetadata && (
                      <div className="rounded-lg border border-border overflow-hidden bg-background">
                        <div className="relative">
                          {form.thumbnailUrl ? (
                            <img src={form.thumbnailUrl} alt={form.title || "Video thumbnail"} className="w-full h-48 object-cover" />
                          ) : (
                            <div className="w-full h-48 bg-muted flex items-center justify-center">
                              <Video className="h-12 w-12 text-muted-foreground" />
                            </div>
                          )}
                          <div className="absolute top-2 left-2">
                            <Badge className={`text-[10px] ${form.videoProvider === "youtube" ? "bg-red-600 hover:bg-red-700 text-white" : form.videoProvider === "vimeo" ? "bg-blue-500 hover:bg-blue-600 text-white" : "bg-muted"}`}>
                              {providerLabel}
                            </Badge>
                          </div>
                          {form.videoDuration && (
                            <div className="absolute bottom-2 right-2">
                              <Badge variant="secondary" className="text-[10px] bg-black/70 text-white">{form.videoDuration}</Badge>
                            </div>
                          )}
                        </div>
                        <div className="p-3 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{form.title || "Untitled Video"}</p>
                              {form.videoAuthor && <p className="text-[11px] text-muted-foreground">{form.videoAuthor}</p>}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                              <span className="text-[11px] text-green-500 font-medium">Parsed</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <a href={form.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline flex items-center gap-1">
                              <ExternalLink className="h-3 w-3" />Open original
                            </a>
                            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={clearVideoUrl}>Remove</Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>

              {/* ── Ad Details Form ──────────────────────────────────────────── */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Title *<AiBadge field="title" />
                </Label>
                <Input
                  placeholder="Enter ad title..."
                  value={form.title}
                  onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Description<AiBadge field="description" />
                </Label>
                <Textarea
                  placeholder="Describe the ad content..."
                  value={form.description}
                  onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
                  className="bg-background min-h-[80px]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Format *<AiBadge field="format" />
                  </Label>
                  <Select value={form.format} onValueChange={(v: any) => setForm(prev => ({ ...prev, format: v }))}>
                    <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
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
                    <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Advertiser — text input with live match feedback */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Advertiser<AiBadge field="advertiser" />
                </Label>
                <Input
                  placeholder="Brand or company name..."
                  value={advertiserName}
                  onChange={e => {
                    const v = e.target.value;
                    setAdvertiserName(v);
                    if (advertiserMatch?.existingId) {
                      setForm(prev => ({ ...prev, advertiserId: undefined }));
                    }
                    setAdvertiserMatch(null);
                  }}
                  onBlur={() => {
                    // checkMatch query fires reactively; sync result on blur for immediacy
                    if (checkMatch.data?.match) {
                      setAdvertiserMatch(checkMatch.data.match);
                      setForm(prev => ({ ...prev, advertiserId: checkMatch.data!.match!.existingId }));
                    }
                  }}
                  className="bg-background"
                />
                {advertiserName.trim() && (
                  <div className="mt-1">
                    {advertiserMatch?.existingId ? (
                      <p className="text-xs text-green-700 flex items-center gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Matched to existing advertiser: <strong>{advertiserMatch.existingName}</strong>
                        <span className="text-green-600/70">({advertiserMatch.confidence})</span>
                      </p>
                    ) : advertiserName.trim().length >= 2 ? (
                      <p className="text-xs text-amber-700 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        New advertiser — will be created on submit
                      </p>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Target Audience<AiBadge field="targetAudience" />
                </Label>
                <Input
                  placeholder="e.g., Adults 18-34, Sports enthusiasts..."
                  value={form.targetAudience}
                  onChange={e => setForm(prev => ({ ...prev, targetAudience: e.target.value }))}
                  className="bg-background"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setLocation("/ads")}>Cancel</Button>
                <Button onClick={handleSubmit} disabled={isSubmitting || isAnalyzing}>
                  {isSubmitting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  {isAnalyzing ? "Analyzing…" : "Submit for Review"}
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
                className={`w-full p-10 rounded-lg border-2 border-dashed transition-colors cursor-pointer text-center ${isDraggingOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
              >
                <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">{isDraggingOver ? "Drop files here" : "Click or drag files here"}</p>
                <p className="text-[11px] text-muted-foreground mt-1">Images, video, audio — up to 16MB each, max 20 files</p>
              </div>

              {batchFiles.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""} queued</p>
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] text-destructive" onClick={() => setBatchFiles([])}>Clear all</Button>
                  </div>
                  {batchFiles.map((bf, i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-background border border-border/50">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${bf.status === "ready" ? "bg-green-500" : bf.status === "uploading" ? "bg-yellow-500 animate-pulse" : bf.status === "error" ? "bg-red-500" : "bg-muted-foreground"}`} />
                      <div className="flex-1 min-w-0">
                        <Input
                          value={bf.title}
                          onChange={e => setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, title: e.target.value } : f))}
                          className="h-7 text-xs bg-card border-0 p-0 focus-visible:ring-0 font-medium"
                        />
                        <p className="text-[10px] text-muted-foreground mt-0.5">{bf.file.name} · {(bf.file.size / 1024).toFixed(0)} KB · {bf.format}</p>
                      </div>
                      <Select value={bf.format} onValueChange={(v: any) => setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, format: v } : f))}>
                        <SelectTrigger className="w-[90px] h-7 text-[11px] bg-card"><SelectValue /></SelectTrigger>
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

              {batchSubmitProgress !== null && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{batchSubmitProgress < 70 ? "Uploading files…" : batchSubmitProgress < 100 ? "Submitting to review queue…" : "Done!"}</span>
                    <span>{batchSubmitProgress}%</span>
                  </div>
                  <Progress value={batchSubmitProgress} className="h-1.5" />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setLocation("/ads")}>Cancel</Button>
                <Button onClick={handleBatchSubmit} disabled={batchFiles.length === 0 || createBatch.isPending || batchSubmitProgress !== null}>
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
