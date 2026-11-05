import { Injectable } from '@angular/core';
import { InternshipMode, InternshipType } from '../../models';
import { supabase } from '../../core/supabase.client';

export interface AdminInternshipRow {
  id: string;
  title: string;
  type: InternshipType;
  mode: InternshipMode;
  domain: string;
  description: string;
  durationLabel: string;
  stipendPerMonth: number;
  price: number;
  originalPrice: number | null;
  hasPpo: boolean;
  skills: string[];
  thumbnailUrl: string | null;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface AdminInternshipInput {
  title: string;
  type: InternshipType;
  mode: InternshipMode;
  domain: string;
  description: string;
  durationLabel: string;
  stipendPerMonth: number;
  price: number;
  originalPrice?: number;
  hasPpo: boolean;
  skills: string[];
  thumbnailUrl?: string;
  status: 'open' | 'closed';
}

@Injectable({ providedIn: 'root' })
export class AdminInternshipsService {
  private readonly fields =
    'id, title, type, mode, domain, description, duration_label, stipend_per_month, price, original_price, has_ppo, skills, thumbnail_url, status, created_at, updated_at';

  async listAll(): Promise<AdminInternshipRow[]> {
    const { data, error } = await supabase
      .from('internships')
      .select(this.fields)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('AdminInternshipsService.listAll:', error);
      return [];
    }

    return (data ?? []).map((r) => this.mapRow(r as Record<string, unknown>));
  }

  async create(input: AdminInternshipInput): Promise<AdminInternshipRow | null> {
    const { data, error } = await supabase
      .from('internships')
      .insert(this.toDb(input))
      .select(this.fields)
      .single();

    if (error) throw new Error(error.message);
    return this.mapRow(data as Record<string, unknown>);
  }

  async update(id: string, input: AdminInternshipInput): Promise<AdminInternshipRow | null> {
    const { data, error } = await supabase
      .from('internships')
      .update(this.toDb(input))
      .eq('id', id)
      .select(this.fields)
      .single();

    if (error) throw new Error(error.message);
    return this.mapRow(data as Record<string, unknown>);
  }

  async delete(id: string): Promise<boolean> {
    const { error } = await supabase.from('internships').delete().eq('id', id);
    return !error;
  }

  async uploadThumbnail(internshipId: string, file: File): Promise<string> {
    const path = `${internshipId}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage
      .from('internship-thumbnails')
      .upload(path, file, { upsert: false, contentType: 'image/jpeg' });

    if (error) throw new Error(error.message);

    const { data } = supabase.storage.from('internship-thumbnails').getPublicUrl(path);
    return data.publicUrl;
  }

  private toDb(input: AdminInternshipInput): Record<string, unknown> {
    return {
      title: input.title.trim(),
      type: input.type,
      mode: input.mode,
      domain: input.domain.trim(),
      description: input.description.trim(),
      duration_label: input.durationLabel.trim(),
      stipend_per_month: input.stipendPerMonth,
      price: input.price,
      original_price: input.originalPrice ?? null,
      has_ppo: input.hasPpo,
      skills: input.skills,
      thumbnail_url: input.thumbnailUrl?.trim() || null,
      status: input.status
    };
  }

  private mapRow(r: Record<string, unknown>): AdminInternshipRow {
    return {
      id: String(r['id']),
      title: String(r['title'] ?? ''),
      type: r['type'] as InternshipType,
      mode: r['mode'] as InternshipMode,
      domain: String(r['domain'] ?? ''),
      description: String(r['description'] ?? ''),
      durationLabel: String(r['duration_label'] ?? ''),
      stipendPerMonth: Number(r['stipend_per_month'] ?? 0),
      price: Number(r['price'] ?? 0),
      originalPrice: r['original_price'] != null ? Number(r['original_price']) : null,
      hasPpo: Boolean(r['has_ppo']),
      skills: Array.isArray(r['skills']) ? (r['skills'] as string[]) : [],
      thumbnailUrl: (r['thumbnail_url'] as string) ?? null,
      status: (r['status'] as 'open' | 'closed') ?? 'open',
      createdAt: String(r['created_at'] ?? ''),
      updatedAt: String(r['updated_at'] ?? '')
    };
  }
}
