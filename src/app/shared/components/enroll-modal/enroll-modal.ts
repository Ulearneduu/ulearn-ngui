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
import { Course } from '../../../models';
import { AuthService } from '../../../core/services/auth.service';
import { ProfileLookupService } from '../../services/profile-lookup.service';
import { CouponService } from '../../services/coupon.service';
import { PaymentService } from '../../services/payment.service';
import { SearchableSelect } from '../searchable-select/searchable-select';
import { ToastService } from '../../../core/services/toast';

export interface LiveClassMonthOption {
  value: string;
  label: string;
}

@Component({
  selector: 'app-enroll-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ReactiveFormsModule, SearchableSelect],
  templateUrl: './enroll-modal.html',
  styleUrl: './enroll-modal.scss'
})
export class EnrollModal implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly lookup = inject(ProfileLookupService);
  private readonly couponService = inject(CouponService);
  private readonly paymentService = inject(PaymentService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly course = input.required<Course>();
  readonly closed = output<void>();

  form!: FormGroup;
  readonly isSubmitting = signal(false);
  readonly showOtherCollege = signal(false);
  readonly couponMessage = signal<string | null>(null);
  readonly couponValid = signal(false);
  readonly couponDiscount = signal(0);
  readonly isValidatingCoupon = signal(false);

  readonly searchColleges = (q: string) => this.lookup.searchColleges(q);
  readonly searchSpecializations = (q: string) => this.lookup.searchSpecializations(q);

  readonly liveClassMonths = computed(() => this.buildLiveClassMonths());
  readonly basePrice = computed(() => this.course().price);
  readonly finalPrice = computed(() => {
    const base = this.basePrice();
    const discount = this.couponValid() ? this.couponDiscount() : 0;
    if (discount <= 0) return base;
    return Math.round(base * (1 - discount / 100));
  });

  canPay(): boolean {
    return !!this.form?.valid && !this.isSubmitting();
  }

  ngOnInit(): void {
    const profile = this.auth.profile();
    const user = this.auth.currentUser();

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
      degreeYear: [
        profile?.current_year?.toString() || '',
        [Validators.required]
      ],
      specialization: [profile?.specialization || '', [Validators.required]],
      liveClassStartMonth: ['', [Validators.required]],
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

  getDiscountPercent(): number {
    const c = this.course();
    if (!c.originalPrice || c.originalPrice <= c.price) return 0;
    return Math.round((1 - c.price / c.originalPrice) * 100);
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
      degreeYear: Number(raw.degreeYear),
      specialization: raw.specialization.trim(),
      liveClassStartMonth: raw.liveClassStartMonth,
      couponCode: this.couponValid() ? couponCode : undefined,
      couponDiscountPercent: this.couponValid() ? this.couponDiscount() : undefined
    };

    const course = this.course();
    const pending = {
      kind: 'course' as const,
      courseId: course.id,
      slug: course.slug,
      price: this.finalPrice(),
      basePrice: course.price,
      title: course.title,
      formData
    };

    this.isSubmitting.set(true);
    this.paymentService.setPendingEnrollment(pending);
    const ok = await this.paymentService.startCheckout(pending);
    this.isSubmitting.set(false);

    if (ok) {
      this.close();
    }
  }

  isFieldInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!(ctrl?.invalid && ctrl.touched);
  }

  private buildLiveClassMonths(): LiveClassMonthOption[] {
    const now = new Date();
    const options: LiveClassMonthOption[] = [];
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    for (let i = 1; i <= 4; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
      options.push({ value, label });
    }

    return options;
  }
}
