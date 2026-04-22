export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cities: {
        Row: {
          active: boolean
          country: string
          created_at: string
          latitude: number
          longitude: number
          name: string
          place_id: string | null
          region: string | null
          slug: string
        }
        Insert: {
          active?: boolean
          country?: string
          created_at?: string
          latitude: number
          longitude: number
          name: string
          place_id?: string | null
          region?: string | null
          slug: string
        }
        Update: {
          active?: boolean
          country?: string
          created_at?: string
          latitude?: number
          longitude?: number
          name?: string
          place_id?: string | null
          region?: string | null
          slug?: string
        }
        Relationships: []
      }
      cost_assumptions_global: {
        Row: {
          cleaning_per_trip: number
          default_acquisition_mode: string
          default_avg_miles_per_day: number | null
          default_avg_miles_per_trip: number
          default_lease_down: number
          default_lease_monthly: number
          default_lease_term_months: number
          default_mileage_cap_monthly: number
          default_mileage_overage_per_mi: number
          default_purchase_price: number
          depreciation_pct_annual: number
          id: number
          insurance_monthly: number
          maintenance_monthly: number
          registration_monthly: number
          tires_monthly: number
          trips_per_month_estimate: number
          turo_fee_pct: number
          updated_at: string
          utilization_pct: number
        }
        Insert: {
          cleaning_per_trip?: number
          default_acquisition_mode?: string
          default_avg_miles_per_day?: number | null
          default_avg_miles_per_trip?: number
          default_lease_down?: number
          default_lease_monthly?: number
          default_lease_term_months?: number
          default_mileage_cap_monthly?: number
          default_mileage_overage_per_mi?: number
          default_purchase_price?: number
          depreciation_pct_annual?: number
          id?: number
          insurance_monthly?: number
          maintenance_monthly?: number
          registration_monthly?: number
          tires_monthly?: number
          trips_per_month_estimate?: number
          turo_fee_pct?: number
          updated_at?: string
          utilization_pct?: number
        }
        Update: {
          cleaning_per_trip?: number
          default_acquisition_mode?: string
          default_avg_miles_per_day?: number | null
          default_avg_miles_per_trip?: number
          default_lease_down?: number
          default_lease_monthly?: number
          default_lease_term_months?: number
          default_mileage_cap_monthly?: number
          default_mileage_overage_per_mi?: number
          default_purchase_price?: number
          depreciation_pct_annual?: number
          id?: number
          insurance_monthly?: number
          maintenance_monthly?: number
          registration_monthly?: number
          tires_monthly?: number
          trips_per_month_estimate?: number
          turo_fee_pct?: number
          updated_at?: string
          utilization_pct?: number
        }
        Relationships: []
      }
      cost_overrides: {
        Row: {
          acquisition_mode: string | null
          avg_miles_per_day: number | null
          avg_miles_per_trip: number | null
          cleaning_per_trip: number | null
          depreciation_pct_annual: number | null
          insurance_monthly: number | null
          lease_down: number | null
          lease_monthly: number | null
          lease_term_months: number | null
          maintenance_monthly: number | null
          mileage_cap_monthly: number | null
          mileage_overage_per_mi: number | null
          notes: string | null
          purchase_price: number | null
          registration_monthly: number | null
          tires_monthly: number | null
          turo_fee_pct: number | null
          updated_at: string
          utilization_pct: number | null
          vehicle_id: string
        }
        Insert: {
          acquisition_mode?: string | null
          avg_miles_per_day?: number | null
          avg_miles_per_trip?: number | null
          cleaning_per_trip?: number | null
          depreciation_pct_annual?: number | null
          insurance_monthly?: number | null
          lease_down?: number | null
          lease_monthly?: number | null
          lease_term_months?: number | null
          maintenance_monthly?: number | null
          mileage_cap_monthly?: number | null
          mileage_overage_per_mi?: number | null
          notes?: string | null
          purchase_price?: number | null
          registration_monthly?: number | null
          tires_monthly?: number | null
          turo_fee_pct?: number | null
          updated_at?: string
          utilization_pct?: number | null
          vehicle_id: string
        }
        Update: {
          acquisition_mode?: string | null
          avg_miles_per_day?: number | null
          avg_miles_per_trip?: number | null
          cleaning_per_trip?: number | null
          depreciation_pct_annual?: number | null
          insurance_monthly?: number | null
          lease_down?: number | null
          lease_monthly?: number | null
          lease_term_months?: number | null
          maintenance_monthly?: number | null
          mileage_cap_monthly?: number | null
          mileage_overage_per_mi?: number | null
          notes?: string | null
          purchase_price?: number | null
          registration_monthly?: number | null
          tires_monthly?: number | null
          turo_fee_pct?: number | null
          updated_at?: string
          utilization_pct?: number | null
          vehicle_id?: string
        }
        Relationships: []
      }
      listings_current: {
        Row: {
          avg_daily_price: number | null
          city: string
          completed_trips: number | null
          currency: string | null
          fuel_type: string | null
          host_id: string | null
          host_name: string | null
          image_url: string | null
          is_all_star_host: boolean | null
          last_scraped_at: string
          latitude: number | null
          location_city: string | null
          location_state: string | null
          longitude: number | null
          make: string | null
          model: string | null
          price_14d_avg: number | null
          price_30d_avg: number | null
          price_7d_avg: number | null
          rating: number | null
          trim: string | null
          updated_at: string
          vehicle_id: string
          vehicle_type: string | null
          year: number | null
        }
        Insert: {
          avg_daily_price?: number | null
          city: string
          completed_trips?: number | null
          currency?: string | null
          fuel_type?: string | null
          host_id?: string | null
          host_name?: string | null
          image_url?: string | null
          is_all_star_host?: boolean | null
          last_scraped_at?: string
          latitude?: number | null
          location_city?: string | null
          location_state?: string | null
          longitude?: number | null
          make?: string | null
          model?: string | null
          price_14d_avg?: number | null
          price_30d_avg?: number | null
          price_7d_avg?: number | null
          rating?: number | null
          trim?: string | null
          updated_at?: string
          vehicle_id: string
          vehicle_type?: string | null
          year?: number | null
        }
        Update: {
          avg_daily_price?: number | null
          city?: string
          completed_trips?: number | null
          currency?: string | null
          fuel_type?: string | null
          host_id?: string | null
          host_name?: string | null
          image_url?: string | null
          is_all_star_host?: boolean | null
          last_scraped_at?: string
          latitude?: number | null
          location_city?: string | null
          location_state?: string | null
          longitude?: number | null
          make?: string | null
          model?: string | null
          price_14d_avg?: number | null
          price_30d_avg?: number | null
          price_7d_avg?: number | null
          rating?: number | null
          trim?: string | null
          updated_at?: string
          vehicle_id?: string
          vehicle_type?: string | null
          year?: number | null
        }
        Relationships: []
      }
      listings_snapshots: {
        Row: {
          avg_daily_price: number | null
          city: string
          completed_trips: number | null
          created_at: string
          currency: string | null
          fuel_type: string | null
          host_id: string | null
          host_name: string | null
          id: string
          image_url: string | null
          is_all_star_host: boolean | null
          latitude: number | null
          location_city: string | null
          location_state: string | null
          longitude: number | null
          make: string | null
          model: string | null
          price_14d_avg: number | null
          price_30d_avg: number | null
          price_7d_avg: number | null
          rating: number | null
          raw: Json | null
          scraped_at: string
          trim: string | null
          vehicle_id: string
          vehicle_type: string | null
          year: number | null
        }
        Insert: {
          avg_daily_price?: number | null
          city: string
          completed_trips?: number | null
          created_at?: string
          currency?: string | null
          fuel_type?: string | null
          host_id?: string | null
          host_name?: string | null
          id?: string
          image_url?: string | null
          is_all_star_host?: boolean | null
          latitude?: number | null
          location_city?: string | null
          location_state?: string | null
          longitude?: number | null
          make?: string | null
          model?: string | null
          price_14d_avg?: number | null
          price_30d_avg?: number | null
          price_7d_avg?: number | null
          rating?: number | null
          raw?: Json | null
          scraped_at?: string
          trim?: string | null
          vehicle_id: string
          vehicle_type?: string | null
          year?: number | null
        }
        Update: {
          avg_daily_price?: number | null
          city?: string
          completed_trips?: number | null
          created_at?: string
          currency?: string | null
          fuel_type?: string | null
          host_id?: string | null
          host_name?: string | null
          id?: string
          image_url?: string | null
          is_all_star_host?: boolean | null
          latitude?: number | null
          location_city?: string | null
          location_state?: string | null
          longitude?: number | null
          make?: string | null
          model?: string | null
          price_14d_avg?: number | null
          price_30d_avg?: number | null
          price_7d_avg?: number | null
          rating?: number | null
          raw?: Json | null
          scraped_at?: string
          trim?: string | null
          vehicle_id?: string
          vehicle_type?: string | null
          year?: number | null
        }
        Relationships: []
      }
      price_forecasts: {
        Row: {
          avg_price: number | null
          city: string
          created_at: string
          id: string
          max_price: number | null
          min_price: number | null
          scraped_at: string
          vehicle_id: string
          window_end: string
          window_label: string
          window_start: string
        }
        Insert: {
          avg_price?: number | null
          city: string
          created_at?: string
          id?: string
          max_price?: number | null
          min_price?: number | null
          scraped_at?: string
          vehicle_id: string
          window_end: string
          window_label: string
          window_start: string
        }
        Update: {
          avg_price?: number | null
          city?: string
          created_at?: string
          id?: string
          max_price?: number | null
          min_price?: number | null
          scraped_at?: string
          vehicle_id?: string
          window_end?: string
          window_label?: string
          window_start?: string
        }
        Relationships: []
      }
      scrape_runs: {
        Row: {
          city: string
          error_message: string | null
          finished_at: string | null
          id: string
          segments_run: number | null
          started_at: string
          status: string
          vehicles_count: number | null
        }
        Insert: {
          city: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          segments_run?: number | null
          started_at?: string
          status: string
          vehicles_count?: number | null
        }
        Update: {
          city?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          segments_run?: number | null
          started_at?: string
          status?: string
          vehicles_count?: number | null
        }
        Relationships: []
      }
      watchlist: {
        Row: {
          added_at: string
          notes: string | null
          vehicle_id: string
        }
        Insert: {
          added_at?: string
          notes?: string | null
          vehicle_id: string
        }
        Update: {
          added_at?: string
          notes?: string | null
          vehicle_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
