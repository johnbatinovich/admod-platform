import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldCheck, Plus, Trash2, Loader2, Building, Ban } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function BrandSafety() {
  const utils = trpc.useUtils();
  const { data: blocks, isLoading: blocksLoading } = trpc.categoryBlocks.list.useQuery();
  const { data: advertisers, isLoading: advLoading } = trpc.advertisers.list.useQuery();
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [showAddAdvertiser, setShowAddAdvertiser] = useState(false);

  const deleteBlock = trpc.categoryBlocks.delete.useMutation({
    onSuccess: () => { utils.categoryBlocks.list.invalidate(); toast.success("Block removed"); },
  });

  const updateAdvertiser = trpc.advertisers.update.useMutation({
    onSuccess: () => { utils.advertisers.list.invalidate(); toast.success("Advertiser updated"); },
  });

  const verificationColors: Record<string, string> = {
    pending: "bg-yellow-500/15 text-yellow-400",
    verified: "bg-green-500/15 text-green-400",
    rejected: "bg-red-500/15 text-red-400",
    suspended: "bg-orange-500/15 text-orange-400",
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Brand Safety</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage advertiser verification and content category blocking.</p>
      </div>

      <Tabs defaultValue="advertisers">
        <TabsList className="bg-card border border-border">
          <TabsTrigger value="advertisers" className="text-xs">Advertisers ({advertisers?.length || 0})</TabsTrigger>
          <TabsTrigger value="blocks" className="text-xs">Category Blocks ({blocks?.length || 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="advertisers">
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Advertisers</CardTitle>
                <Dialog open={showAddAdvertiser} onOpenChange={setShowAddAdvertiser}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-1.5" />Add Advertiser</Button>
                  </DialogTrigger>
                  <DialogContent className="bg-card">
                    <DialogHeader><DialogTitle>Add Advertiser</DialogTitle></DialogHeader>
                    <AddAdvertiserForm onSuccess={() => { setShowAddAdvertiser(false); utils.advertisers.list.invalidate(); }} />
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {advLoading ? (
                <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
              ) : advertisers && advertisers.length > 0 ? (
                <div className="space-y-2">
                  {advertisers.map(adv => (
                    <div key={adv.id} className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center">
                          <Building className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{adv.name}</p>
                          <p className="text-[11px] text-muted-foreground">{adv.industry || "No industry"} · {adv.contactEmail || "No email"}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${verificationColors[adv.verificationStatus]}`}>
                          {adv.verificationStatus}
                        </Badge>
                        {adv.verificationStatus === "pending" && (
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 text-[11px] text-green-400" onClick={() => updateAdvertiser.mutate({ id: adv.id, verificationStatus: "verified" })}>Verify</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[11px] text-red-400" onClick={() => updateAdvertiser.mutate({ id: adv.id, verificationStatus: "rejected" })}>Reject</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Building className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">No advertisers registered.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blocks">
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Category Blocks</CardTitle>
                <Dialog open={showAddBlock} onOpenChange={setShowAddBlock}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-1.5" />Add Block</Button>
                  </DialogTrigger>
                  <DialogContent className="bg-card">
                    <DialogHeader><DialogTitle>Add Category Block</DialogTitle></DialogHeader>
                    <AddBlockForm onSuccess={() => { setShowAddBlock(false); utils.categoryBlocks.list.invalidate(); }} />
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {blocksLoading ? (
                <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : blocks && blocks.length > 0 ? (
                <div className="space-y-2">
                  {blocks.map(block => (
                    <div key={block.id} className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50">
                      <div className="flex items-center gap-3">
                        <Ban className="h-4 w-4 text-destructive" />
                        <div>
                          <p className="text-sm font-medium">{block.category}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {block.isGlobal ? "Global block" : `Advertiser #${block.advertiserId}`}
                            {block.reason && ` · ${block.reason}`}
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => deleteBlock.mutate({ id: block.id })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">No category blocks configured.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AddAdvertiserForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState({ name: "", contactEmail: "", contactPhone: "", industry: "", website: "", notes: "" });
  const create = trpc.advertisers.create.useMutation({
    onSuccess: () => { toast.success("Advertiser added"); onSuccess(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="space-y-1"><Label className="text-sm">Name *</Label><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="bg-background" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1"><Label className="text-sm">Email</Label><Input value={form.contactEmail} onChange={e => setForm(p => ({ ...p, contactEmail: e.target.value }))} className="bg-background" /></div>
        <div className="space-y-1"><Label className="text-sm">Phone</Label><Input value={form.contactPhone} onChange={e => setForm(p => ({ ...p, contactPhone: e.target.value }))} className="bg-background" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1"><Label className="text-sm">Industry</Label><Input value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} className="bg-background" /></div>
        <div className="space-y-1"><Label className="text-sm">Website</Label><Input value={form.website} onChange={e => setForm(p => ({ ...p, website: e.target.value }))} className="bg-background" /></div>
      </div>
      <div className="space-y-1"><Label className="text-sm">Notes</Label><Textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="bg-background" /></div>
      <Button onClick={() => { if (!form.name.trim()) { toast.error("Name required"); return; } create.mutate({ name: form.name, contactEmail: form.contactEmail || undefined, contactPhone: form.contactPhone || undefined, industry: form.industry || undefined, website: form.website || undefined, notes: form.notes || undefined }); }} disabled={create.isPending} className="w-full">
        {create.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Add Advertiser
      </Button>
    </div>
  );
}

function AddBlockForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState({ category: "", reason: "", isGlobal: true });
  const create = trpc.categoryBlocks.create.useMutation({
    onSuccess: () => { toast.success("Block added"); onSuccess(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="space-y-1"><Label className="text-sm">Category *</Label><Input value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} className="bg-background" placeholder="e.g., Gambling, Tobacco, Firearms..." /></div>
      <div className="space-y-1"><Label className="text-sm">Reason</Label><Textarea value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} className="bg-background" /></div>
      <div className="flex items-center gap-2"><Switch checked={form.isGlobal} onCheckedChange={v => setForm(p => ({ ...p, isGlobal: v }))} /><Label className="text-sm">Global block (applies to all advertisers)</Label></div>
      <Button onClick={() => { if (!form.category.trim()) { toast.error("Category required"); return; } create.mutate({ category: form.category, reason: form.reason || undefined, isGlobal: form.isGlobal }); }} disabled={create.isPending} className="w-full">
        {create.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Add Block
      </Button>
    </div>
  );
}
