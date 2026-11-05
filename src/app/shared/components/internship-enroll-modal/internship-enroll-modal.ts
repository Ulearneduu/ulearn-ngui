import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  ChangeDetectorRef,
  computed,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Internship } from '../../../models';
import { AuthService } from '../../../core/services/auth.service';
import { ProfileLookupService } from '../../services/profile-lookup.service';
import { CouponService } from '../../services/coupon.service';
import { PaymentService } from '../../services/payment.service';
import { SearchableSelect } from '../searchable-select/searchable-select';

@Component({
  selector: 'app-internship-enroll-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ReactiveFormsModule, SearchableSelect],
  templateUrl: './internship-enroll-modal.html',
  styleUrl: './internship-enroll-modal.scss'
})
export class InternshipEnrollModal implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly lookup = inject(ProfileLookupService);
  private readonly couponService = inject(CouponService);
  private readonly paymentService = inject(PaymentService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly internship = input.required<Internship>();
  readonly returnUrl = input<string>('/internships/short');
  readonly closed = output<void>();
  readonly enrolled = output<void>();

  form!: FormGroup;
  readonly isSubmitting = signal(false);
  readonly showOtherCollege = signal(false);
  readonly couponMessage = signal<string | null>(null);
  readonly couponValid = signal(false);
  readonly couponDiscount = signal(0);
  readonly isValidatingCoupon = signal(false);

  readonly searchColleges = (q: string) => this.lookup.searchColleges(q);
  readonly searchSpecializations = (q: string) => this.lookup.searchSpecializations(q);

  readonly graduationYears = computed(() => this.buildGraduationYears());
  readonly basePrice = computed(() => Math.max(0, this.internship().price));
  readonly listPrice = computed(() => {
    const original = this.internship().originalPrice;
    return original != null && original > 0 ? original : 0;
  });
  readonly showListPrice = computed(() => this.listPrice() > this.basePrice());
  readonly isFreeEnrollment = computed(() => this.basePrice() <= 0);
  readonly finalPrice = computed(() => {
    const base = this.basePrice();
    const discount = this.couponValid() ? this.couponDiscount() : 0;
    if (discount <= 0) return base;
    return Math.max(0, Math.round(base * (1 - discount / 100)));
  });
  readonly couponDiscountAmount = computed(() => {
    if (!this.couponValid() || this.couponDiscount() <= 0) return 0;
    return Math.max(0, this.basePrice() - this.finalPrice());
  });

  canPay(): boolean {
    return !!this.form?.valid && !this.isSubmitting();
  }

  ngOnInit(): void {
    const profile = this.auth.profile();
    const user = this.auth.currentUser();
    const gradDefault = profile?.current_year
      ? String(new Date().getFullYear() + (5 - Number(profile.current_year)))
      : '';

    this.form = this.fb.group({
      fullName: [profile?.full_name || '', [Validators.required, Validators.minLength(2)]],
      phone: [
        profile?.phone || '',
        [Validators.required, Validators.pattern(/^\+?[0-9]{10,15}$/)]
      ],
      email: [{ value: user?.email || '', disabled: true }, [Validators.required, Validators.email]],
      collegeName: [profile?.college_name || '', [Validators.required]],
      otherCollegeName: [''],
      degree: [profile?.degree || '', [Validators.required]],
      graduationYear: [gradDefault, [Validators.required]],
      specialization: [profile?.specialization || '', [Validators.required]],
      couponCode: ['']
    });

    this.form.get('collegeName')?.valueChanges.subscribe((v: string) => {
      const isOther = v === 'Other';
      this.showOtherCollege.set(isOther);
      const otherCtrl = this.form.get('otherCollegeName');
      if (isOther) {
        otherCtrl?.setValidators([Validators.required, Validators.minLength(2)]);
      } else {
        otherCtrl?.clearValidators();
        otherCtrl?.setValue('');
      }
      otherCtrl?.updateValueAndValidity();
    });

    if (profile?.college_name === 'Other') {
      this.showOtherCollege.set(true);
    }

    this.form.statusChanges.subscribe(() => this.cdr.markForCheck());
  }

  close(): void {
    this.closed.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  formatPrice(price: number): string {
    return '₹' + price.toLocaleString('en-IN');
  }

  formatStipend(amount: number): string {
    return '₹' + amount.toLocaleString('en-IN') + '/mo';
  }

  getListDiscountPercent(): number {
    const i = this.internship();
    if (!i.originalPrice || i.originalPrice <= i.price) return 0;
    return Math.round((1 - i.price / i.originalPrice) * 100);
  }

  listDiscountAmount(): number {
    if (!this.showListPrice()) return 0;
    return Math.max(0, this.listPrice() - this.basePrice());
  }

  getTypeLabel(type: Internship['type']): string {
    return type === 'short' ? 'Short Term' : 'Long Term';
  }

  applyCoupon(): void {
    const code = (this.form.get('couponCode')?.value as string)?.trim();
    if (!code) {
      this.couponValid.set(false);
      this.couponDiscount.set(0);
      this.couponMessage.set(null);
      return;
    }

    this.isValidatingCoupon.set(true);
    this.couponService.validateCoupon(code).subscribe({
      next: (result) => {
        this.isValidatingCoupon.set(false);
        this.couponValid.set(result.valid);
        this.couponDiscount.set(result.discountPercentage ?? 0);
        this.couponMessage.set(result.message);
        if (!result.valid) {
          this.couponDiscount.set(0);
        }
      },
      error: () => {
        this.isValidatingCoupon.set(false);
        this.couponValid.set(false);
        this.couponDiscount.set(0);
        this.couponMessage.set('Could not validate coupon');
      }
    });
  }

  clearCoupon(): void {
    this.form.get('couponCode')?.setValue('');
    this.couponValid.set(false);
    this.couponDiscount.set(0);
    this.couponMessage.set(null);
  }

  async onSubmit(): Promise<void> {
    this.form.markAllAsTouched();
    if (!this.form.valid || this.isSubmitting()) return;

    const raw = this.form.getRawValue();
    const collegeName =
      raw.collegeName === 'Other' ? raw.otherCollegeName.trim() : raw.collegeName.trim();

    const couponCode = (raw.couponCode as string)?.trim() || undefined;
    const formData = {
      fullName: raw.fullName.trim(),
      phone: raw.phone.trim(),
      email: raw.email.trim(),
      collegeName,
      degree: raw.degree,
      graduationYear: Number(raw.graduationYear),
      specialization: raw.specialization.trim(),
      couponCode: this.couponValid() ? couponCode : undefined,
      couponDiscountPercent: this.couponValid() ? this.couponDiscount() : undefined
    };

    const intern = this.internship();
    const pending = {
      internshipId: intern.id,
      price: this.finalPrice(),
      basePrice: intern.price,
      title: intern.title,
      returnUrl: this.returnUrl(),
      formData
    };

    this.isSubmitting.set(true);
    this.paymentService.setPendingInternshipCheckout(pending);
    const ok = await this.paymentService.startInternshipCheckout({
      kind: 'internship',
      ...pending
    });
    this.isSubmitting.set(false);

    if (ok) {
      this.enrolled.emit();
      this.close();
    }
  }

  isFieldInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!(ctrl?.invalid && ctrl.touched);
  }

  payButtonLabel(): string {
    const amount = this.finalPrice();
    if (amount <= 0) {
      return 'Complete enrollment →';
    }
    return `Pay ${this.formatPrice(amount)} →`;
  }

  private buildGraduationYears(): number[] {
    const start = new Date().getFullYear() - 1;
    const years: number[] = [];
    for (let y = start; y <= start + 8; y++) {
      years.push(y);
    }
    return years;
  }
}
